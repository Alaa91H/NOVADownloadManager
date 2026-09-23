package com.nova.downloadmanager.downloads

import android.content.Context
import android.net.Uri
import android.util.Base64
import com.nova.downloadmanager.core.NovaNativeCore
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * NOVA-owned Android transfer-task host.
 *
 * Network bytes are downloaded by NOVA's shared Rust core into app-private
 * staging storage. Kotlin owns only Android lifecycle/catalog projection and
 * final app-private file placement. Raw URLs never enter the task catalog;
 * durable resume intent is stored separately using Android Keystore encryption.
 *
 * Process-death recovery reconciles orphaned active tasks to Paused while
 * preserving native staging bytes and encrypted resume intent.
 */
class NovaTransferCore(context: Context) {
    private val appContext = context.applicationContext
    private val nativeBridgeApiVersion = NovaNativeCore.requireCompatible()
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val intentStore = SecureTransferIntentStore(appContext)
    private val appPrivateRoot = appContext.filesDir

    fun enqueue(url: String): Result<DownloadSummary> = runCatching {
        check(nativeBridgeApiVersion > 0) { "NOVA native core is not initialized" }

        val source = Uri.parse(url.trim())
        require(source.scheme.equals("http", ignoreCase = true) || source.scheme.equals("https", ignoreCase = true)) {
            "Only HTTP(S) download URLs are supported"
        }
        require(!source.host.isNullOrBlank()) { "A download host is required" }

        val id = UUID.randomUUID().toString()
        val fileName = safeFileName(source)
        val record = TransferRecord(
            id = id,
            name = fileName,
            stagingRelativePath = "$STAGING_DIRECTORY/$id.part",
            finalRelativePath = "$FINAL_DIRECTORY/$id-$fileName",
            status = DownloadStatus.Queued.wireValue,
            downloadedBytes = 0,
            totalBytes = 0,
            createdAtMillis = System.currentTimeMillis(),
        )
        remember(record)
        intentStore.put(record.id, source.toString())
        summary(record)
    }

    fun restore(): List<DownloadSummary> {
        reconcileOrphanedSessions()
        return records().map(::summary)
    }

    fun refresh(taskIds: Collection<String>): List<DownloadSummary> {
        val requested = taskIds.toSet()
        return records()
            .filter { requested.isEmpty() || it.id in requested }
            .map(::summary)
    }

    /** Invoked by Android lifecycle reconciliation without starting duplicate work. */
    fun reconcile(): List<DownloadSummary> {
        reconcileOrphanedSessions()
        return records().map(::summary)
    }

    fun pause(taskId: String): Result<DownloadSummary> = runCatching {
        val record = requireRecord(taskId)
        if (ACTIVE_TRANSFER_IDS.contains(taskId)) {
            check(NovaNativeCore.pauseTransfer(taskId)) { "NOVA native transfer is not active" }
        }
        val paused = record.copy(status = DownloadStatus.Paused.wireValue)
        updateRecord(paused)
        summary(paused)
    }

    fun resume(taskId: String): Result<DownloadSummary> = runCatching {
        val record = requireRecord(taskId)
        require(record.status in RESUMABLE_DOWNLOAD_STATUSES) {
            "Transfer cannot be resumed from state ${record.status}"
        }
        requireNotNull(intentStore.get(taskId)) {
            "Encrypted NOVA transfer intent is unavailable"
        }
        check(!ACTIVE_TRANSFER_IDS.contains(taskId)) { "NOVA native transfer is still active" }

        val queued = record.copy(status = DownloadStatus.Queued.wireValue)
        updateRecord(queued)
        summary(queued)
    }

    fun cancel(taskId: String): Result<DownloadSummary> = runCatching {
        val record = requireRecord(taskId)
        val active = ACTIVE_TRANSFER_IDS.contains(taskId)
        if (active) {
            check(NovaNativeCore.cancelTransfer(taskId)) { "NOVA native transfer is not active" }
        } else {
            check(
                NovaNativeCore.discardAppPrivateTransfer(
                    appPrivateRoot.absolutePath,
                    record.stagingRelativePath,
                ),
            ) { "NOVA native staging cleanup failed" }
            NovaNativeCore.forgetTransferProgress(taskId)
            intentStore.remove(taskId)
            updateRecord(
                record.copy(
                    status = DownloadStatus.Cancelled.wireValue,
                    downloadedBytes = 0,
                ),
            )
        }
        summary(requireRecord(taskId))
    }

    /**
     * Persist the latest native progress so Android process death loses at most
     * one lifecycle polling interval rather than the whole segmented session.
     */
    fun checkpointProgress(taskId: String): DownloadSummary? {
        val record = records().firstOrNull { it.id == taskId } ?: return null
        val progress = NovaNativeCore.transferProgress(taskId) ?: return summary(record)
        val updated = record.copy(
            downloadedBytes = maxOf(record.downloadedBytes, progress.downloadedBytes),
            totalBytes = maxOf(record.totalBytes, progress.totalBytes),
        )
        if (updated != record) {
            updateRecord(updated)
        }
        return summary(updated)
    }

    /**
     * Execute one persisted task synchronously on the caller-owned background
     * execution context. JobScheduler/WorkManager owns that context; this class
     * owns only the durable task state and Rust transfer invocation.
     */
    fun execute(taskId: String): Result<DownloadSummary> = runCatching {
        val record = requireRecord(taskId)
        require(record.status in EXECUTABLE_DOWNLOAD_STATUSES) {
            "Transfer cannot execute from state ${record.status}"
        }
        val url = requireNotNull(intentStore.get(taskId)) {
            "Encrypted NOVA transfer intent is unavailable"
        }
        check(ACTIVE_TRANSFER_IDS.add(taskId)) {
            "NOVA native transfer is already active"
        }

        try {
            runNativeTransfer(record, url)
            summary(requireRecord(taskId))
        } finally {
            ACTIVE_TRANSFER_IDS.remove(taskId)
        }
    }

    fun task(taskId: String): DownloadSummary? =
        records().firstOrNull { it.id == taskId }?.let(::summary)

    fun isActive(taskId: String): Boolean = ACTIVE_TRANSFER_IDS.contains(taskId)

    private fun runNativeTransfer(record: TransferRecord, url: String) {
        var current = record.copy(status = DownloadStatus.Downloading.wireValue)
        updateRecord(current)

        try {
            val outcome = NovaNativeCore.downloadToAppPrivate(
                taskId = current.id,
                url = url,
                appPrivateRoot = appPrivateRoot.absolutePath,
                relativeDestination = current.stagingRelativePath,
            )
            val progress = NovaNativeCore.transferProgress(current.id)

            when (outcome.status) {
                NovaNativeCore.NativeTransferStatus.COMPLETED -> {
                    finalizeStaging(current)
                    intentStore.remove(current.id)
                    current = current.copy(
                        status = DownloadStatus.Completed.wireValue,
                        downloadedBytes = outcome.finalBytes,
                        totalBytes = maxOf(
                            current.totalBytes,
                            progress?.totalBytes ?: 0,
                            outcome.finalBytes,
                        ),
                    )
                    NovaNativeCore.forgetTransferProgress(current.id)
                }
                NovaNativeCore.NativeTransferStatus.PAUSED -> {
                    current = current.copy(
                        status = DownloadStatus.Paused.wireValue,
                        downloadedBytes = maxOf(
                            current.downloadedBytes,
                            progress?.downloadedBytes ?: 0,
                        ),
                        totalBytes = maxOf(
                            current.totalBytes,
                            progress?.totalBytes ?: 0,
                        ),
                    )
                }
                NovaNativeCore.NativeTransferStatus.CANCELLED -> {
                    intentStore.remove(current.id)
                    current = current.copy(
                        status = DownloadStatus.Cancelled.wireValue,
                        downloadedBytes = 0,
                    )
                    NovaNativeCore.forgetTransferProgress(current.id)
                }
            }
            updateRecord(current)
            NovaNativeCore.forgetTransferProgress(current.id)
        } catch (_: Throwable) {
            val progress = runCatching {
                NovaNativeCore.transferProgress(current.id)
            }.getOrNull()
            current = current.copy(
                status = DownloadStatus.Failed.wireValue,
                downloadedBytes = maxOf(
                    current.downloadedBytes,
                    progress?.downloadedBytes ?: 0,
                ),
                totalBytes = maxOf(
                    current.totalBytes,
                    progress?.totalBytes ?: 0,
                ),
            )
            updateRecord(current)
            runCatching { NovaNativeCore.forgetTransferProgress(current.id) }
        }
    }

    private fun finalizeStaging(record: TransferRecord) {
        val staging = File(appPrivateRoot, record.stagingRelativePath)
        val destination = File(appPrivateRoot, record.finalRelativePath)
        destination.parentFile?.mkdirs()
        require(staging.isFile) { "NOVA native staging output is missing" }

        runCatching {
            Files.move(
                staging.toPath(),
                destination.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        }.recoverCatching {
            Files.move(
                staging.toPath(),
                destination.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
            )
        }.getOrThrow()
    }

    private fun reconcileOrphanedSessions() {
        records()
            .filter { record ->
                record.status in ACTIVE_DOWNLOAD_STATUSES && !ACTIVE_TRANSFER_IDS.contains(record.id)
            }
            .forEach { record ->
                updateRecord(record.copy(status = DownloadStatus.Paused.wireValue))
            }
    }

    private fun requireRecord(taskId: String): TransferRecord =
        records().firstOrNull { it.id == taskId }
            ?: error("Unknown NOVA transfer task: $taskId")

    private fun summary(record: TransferRecord): DownloadSummary {
        val payload = when (record.status) {
            DownloadStatus.Completed.wireValue -> File(appPrivateRoot, record.finalRelativePath)
            DownloadStatus.Cancelled.wireValue -> null
            else -> File(appPrivateRoot, record.stagingRelativePath)
        }
        val fileBytes = payload
            ?.takeIf(File::isFile)
            ?.length()
            ?.coerceAtLeast(0)
            ?: 0L
        val nativeProgress = if (ACTIVE_TRANSFER_IDS.contains(record.id)) {
            runCatching { NovaNativeCore.transferProgress(record.id) }.getOrNull()
        } else {
            null
        }
        val downloadedBytes = maxOf(
            record.downloadedBytes,
            fileBytes,
            nativeProgress?.downloadedBytes ?: 0,
        )
        val totalBytes = maxOf(
            record.totalBytes,
            nativeProgress?.totalBytes ?: 0,
            downloadedBytes.takeIf { record.status == DownloadStatus.Completed.wireValue } ?: 0L,
        )

        return DownloadSummary(
            id = record.id,
            name = record.name,
            status = record.status,
            downloadedBytes = downloadedBytes,
            totalBytes = totalBytes,
        )
    }

    private fun remember(record: TransferRecord) = synchronized(CATALOG_LOCK) {
        val next = (recordsUnlocked() + record)
            .distinctBy(TransferRecord::id)
            .sortedByDescending(TransferRecord::createdAtMillis)
            .take(MAX_RETAINED_TASKS)
        writeRecords(next)
    }

    private fun updateRecord(record: TransferRecord) = synchronized(CATALOG_LOCK) {
        val next = recordsUnlocked()
            .map { existing -> if (existing.id == record.id) record else existing }
            .let { records ->
                if (records.none { it.id == record.id }) records + record else records
            }
            .sortedByDescending(TransferRecord::createdAtMillis)
            .take(MAX_RETAINED_TASKS)
        writeRecords(next)
    }

    private fun records(): List<TransferRecord> = synchronized(CATALOG_LOCK) {
        recordsUnlocked()
    }

    private fun recordsUnlocked(): List<TransferRecord> = preferences
        .getStringSet(KEY_RECORDS, emptySet())
        .orEmpty()
        .mapNotNull(TransferRecord::decode)
        .sortedByDescending(TransferRecord::createdAtMillis)

    private fun writeRecords(records: List<TransferRecord>) {
        val encoded = records.map(TransferRecord::encode).toSet()
        check(preferences.edit().putStringSet(KEY_RECORDS, encoded).commit()) {
            "Failed to persist NOVA native transfer catalog"
        }
    }

    private fun safeFileName(uri: Uri): String {
        val raw = Uri.decode(uri.lastPathSegment.orEmpty())
            .substringAfterLast('/')
            .takeIf(String::isNotBlank)
            ?: DEFAULT_FILE_NAME
        val sanitized = raw
            .replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_")
            .trim('.', '_', ' ')
            .take(MAX_FILE_NAME_CHARS)
        return sanitized.ifBlank { DEFAULT_FILE_NAME }
    }

    private data class TransferRecord(
        val id: String,
        val name: String,
        val stagingRelativePath: String,
        val finalRelativePath: String,
        val status: String,
        val downloadedBytes: Long,
        val totalBytes: Long,
        val createdAtMillis: Long,
    ) {
        fun encode(): String = listOf(
            id,
            encodeText(name),
            encodeText(stagingRelativePath),
            encodeText(finalRelativePath),
            status,
            downloadedBytes.toString(),
            totalBytes.toString(),
            createdAtMillis.toString(),
        ).joinToString(RECORD_SEPARATOR)

        companion object {
            fun decode(raw: String): TransferRecord? {
                val fields = raw.split(RECORD_SEPARATOR)
                if (fields.size != RECORD_FIELD_COUNT_V1 && fields.size != RECORD_FIELD_COUNT_V2) {
                    return null
                }

                return runCatching {
                    val downloadedIndex = if (fields.size == RECORD_FIELD_COUNT_V2) 5 else null
                    val totalIndex = if (fields.size == RECORD_FIELD_COUNT_V2) 6 else 5
                    val createdIndex = if (fields.size == RECORD_FIELD_COUNT_V2) 7 else 6
                    TransferRecord(
                        id = fields[0].takeIf(String::isNotBlank) ?: return null,
                        name = decodeText(fields[1]),
                        stagingRelativePath = decodeText(fields[2]),
                        finalRelativePath = decodeText(fields[3]),
                        status = fields[4],
                        downloadedBytes = downloadedIndex
                            ?.let { fields[it].toLong().coerceAtLeast(0) }
                            ?: 0,
                        totalBytes = fields[totalIndex].toLong().coerceAtLeast(0),
                        createdAtMillis = fields[createdIndex].toLong().coerceAtLeast(0),
                    )
                }.getOrNull()
            }

            private fun encodeText(value: String): String =
                Base64.encodeToString(value.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)

            private fun decodeText(value: String): String =
                String(Base64.decode(value, Base64.NO_WRAP), Charsets.UTF_8)
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "nova_native_transfer_catalog"
        const val KEY_RECORDS = "records"
        const val MAX_RETAINED_TASKS = 100
        const val MAX_FILE_NAME_CHARS = 120
        const val DEFAULT_FILE_NAME = "download"
        const val STAGING_DIRECTORY = "nova-staging"
        const val FINAL_DIRECTORY = "downloads"
        const val RECORD_SEPARATOR = "|"
        const val RECORD_FIELD_COUNT_V1 = 7
        const val RECORD_FIELD_COUNT_V2 = 8

        val ACTIVE_DOWNLOAD_STATUSES = setOf(
            DownloadStatus.Queued.wireValue,
            DownloadStatus.Downloading.wireValue,
        )
        val RESUMABLE_DOWNLOAD_STATUSES = setOf(
            DownloadStatus.Paused.wireValue,
            DownloadStatus.Failed.wireValue,
        )
        val EXECUTABLE_DOWNLOAD_STATUSES = setOf(
            DownloadStatus.Queued.wireValue,
            DownloadStatus.Failed.wireValue,
        )
        val CATALOG_LOCK = Any()
        val ACTIVE_TRANSFER_IDS = ConcurrentHashMap.newKeySet<String>()
    }
}
