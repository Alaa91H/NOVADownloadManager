package com.nova.downloadmanager.downloads

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.util.Base64
import com.nova.downloadmanager.core.NovaNativeCore
import com.nova.downloadmanager.service.NovaNativeTransferService

/**
 * NOVA-owned Android transfer-task core.
 *
 * New downloads are transferred by the packaged Rust/libcurl engine. Android
 * owns only lifecycle, scoped-storage destination creation, publication, and UI
 * projection. Legacy DownloadManager records remain readable so upgrades do not
 * make existing tasks disappear while the migration is in progress.
 *
 * URLs, request headers, cookies, and tokens are not written to the Android task
 * catalog. Durable source recovery is introduced separately with protected
 * checkpoint storage rather than weakening this boundary.
 */
class NovaTransferCore(context: Context) {
    private val appContext = context.applicationContext
    private val nativeBridgeApiVersion = NovaNativeCore.requireCompatible()
    private val downloadManager = requireNotNull(
        appContext.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager,
    ) { "Android download service is unavailable" }
    private val destinationStore = NativeDestinationStore(appContext)
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun enqueue(url: String): Result<DownloadSummary> = runCatching {
        check(nativeBridgeApiVersion > 0) { "NOVA native core is not initialized" }

        val source = Uri.parse(url.trim())
        require(source.scheme.equals("http", ignoreCase = true) || source.scheme.equals("https", ignoreCase = true)) {
            "Only HTTP(S) download URLs are supported"
        }
        require(!source.host.isNullOrBlank()) { "A download host is required" }

        val nativeProbe = NovaNativeCore.probeHttpResource(source.toString())
        require(nativeProbe.responseStatus in 200..399) {
            "NOVA native HTTP preflight rejected source with status ${nativeProbe.responseStatus}"
        }

        val fileName = safeFileName(source)
        val destination = destinationStore.create(fileName)
        val nativeTaskId = try {
            destination.descriptor.use { descriptor ->
                NovaNativeCore.startHttpDownload(
                    url = source.toString(),
                    outputFd = descriptor.fd,
                    requestedConnections = DEFAULT_NATIVE_CONNECTIONS,
                )
            }
        } catch (failure: Throwable) {
            destinationStore.delete(destination.uri, destination.publishOnComplete)
            throw failure
        }

        val record = TransferRecord.Native(
            id = nativeTaskId,
            name = fileName,
            destinationUri = destination.uri.toString(),
            expectedBytes = nativeProbe.contentLength ?: 0L,
            publishOnComplete = destination.publishOnComplete,
        )
        remember(record)

        // The native worker lives in this process; a data-sync foreground
        // service protects it when the activity leaves the foreground.
        runCatching { NovaNativeTransferService.start(appContext, nativeTaskId) }

        DownloadSummary(
            id = record.publicId,
            name = fileName,
            status = DownloadStatus.Queued.wireValue,
            downloadedBytes = 0,
            totalBytes = record.expectedBytes,
        )
    }

    fun restore(): List<DownloadSummary> = records().mapNotNull(::query)

    fun refresh(taskIds: Collection<String>): List<DownloadSummary> {
        val requested = taskIds.toSet()
        return records()
            .filter { requested.isEmpty() || it.publicId in requested }
            .mapNotNull(::query)
    }

    /** Reconciles native completion/publication and legacy system tasks. */
    fun reconcile(): List<DownloadSummary> = restore()

    private fun query(record: TransferRecord): DownloadSummary? = when (record) {
        is TransferRecord.Native -> queryNative(record)
        is TransferRecord.LegacyDownloadManager -> queryLegacy(record)
    }

    private fun queryNative(record: TransferRecord.Native): DownloadSummary {
        val progress = runCatching {
            NovaNativeCore.queryHttpDownload(record.id)
        }.getOrNull()

        if (progress == null) {
            return DownloadSummary(
                id = record.publicId,
                name = record.name,
                status = DownloadStatus.Failed.wireValue,
                downloadedBytes = 0,
                totalBytes = record.expectedBytes,
            )
        }

        val status = when (progress.state) {
            NovaNativeCore.NativeTransferState.QUEUED -> DownloadStatus.Queued
            NovaNativeCore.NativeTransferState.DOWNLOADING -> DownloadStatus.Downloading
            NovaNativeCore.NativeTransferState.COMPLETED -> {
                val published = runCatching {
                    destinationStore.publish(
                        Uri.parse(record.destinationUri),
                        record.publishOnComplete,
                    )
                }.isSuccess
                if (published) DownloadStatus.Completed else DownloadStatus.Failed
            }
            NovaNativeCore.NativeTransferState.FAILED -> DownloadStatus.Failed
        }

        return DownloadSummary(
            id = record.publicId,
            name = record.name,
            status = status.wireValue,
            downloadedBytes = progress.downloadedBytes,
            totalBytes = progress.totalBytes.takeIf { it > 0L } ?: record.expectedBytes,
        )
    }

    private fun queryLegacy(record: TransferRecord.LegacyDownloadManager): DownloadSummary? {
        val cursor = downloadManager.query(
            DownloadManager.Query().setFilterById(record.id),
        ) ?: return null
        cursor.use {
            if (!it.moveToFirst()) return null
            val status = when (it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                DownloadManager.STATUS_PENDING -> DownloadStatus.Queued
                DownloadManager.STATUS_RUNNING -> DownloadStatus.Downloading
                DownloadManager.STATUS_PAUSED -> DownloadStatus.Paused
                DownloadManager.STATUS_SUCCESSFUL -> DownloadStatus.Completed
                DownloadManager.STATUS_FAILED -> DownloadStatus.Failed
                else -> DownloadStatus.Failed
            }
            val name = it.getString(it.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE))
                ?.takeIf(String::isNotBlank)
                ?: record.name
            return DownloadSummary(
                id = record.publicId,
                name = name,
                status = status.wireValue,
                downloadedBytes = it.getLong(
                    it.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR),
                ).coerceAtLeast(0),
                totalBytes = it.getLong(
                    it.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES),
                ).coerceAtLeast(0),
            )
        }
    }

    private fun remember(record: TransferRecord) {
        val next = (records() + record)
            .distinctBy(TransferRecord::publicId)
            .sortedByDescending(TransferRecord::sortKey)
            .take(MAX_RETAINED_TASKS)
            .map(TransferRecord::encode)
            .toSet()
        preferences.edit().putStringSet(KEY_RECORDS, next).apply()
    }

    private fun records(): List<TransferRecord> = preferences
        .getStringSet(KEY_RECORDS, emptySet())
        .orEmpty()
        .mapNotNull(TransferRecord::decode)
        .sortedByDescending(TransferRecord::sortKey)

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

    private sealed interface TransferRecord {
        val name: String
        val publicId: String
        val sortKey: Long

        fun encode(): String

        data class Native(
            val id: Long,
            override val name: String,
            val destinationUri: String,
            val expectedBytes: Long,
            val publishOnComplete: Boolean,
        ) : TransferRecord {
            override val publicId: String = "native:$id"
            override val sortKey: Long = id

            override fun encode(): String = listOf(
                NATIVE_RECORD_PREFIX,
                id.toString(),
                expectedBytes.toString(),
                if (publishOnComplete) "1" else "0",
                encodeBase64(name),
                encodeBase64(destinationUri),
            ).joinToString(":")
        }

        data class LegacyDownloadManager(
            val id: Long,
            override val name: String,
        ) : TransferRecord {
            override val publicId: String = id.toString()
            override val sortKey: Long = id

            override fun encode(): String = "$id:${encodeBase64(name)}"
        }

        companion object {
            fun decode(raw: String): TransferRecord? {
                if (raw.startsWith("$NATIVE_RECORD_PREFIX:")) {
                    val parts = raw.split(':', limit = 6)
                    if (parts.size != 6) return null
                    val id = parts[1].toLongOrNull()?.takeIf { it > 0L } ?: return null
                    val expectedBytes = parts[2].toLongOrNull()?.coerceAtLeast(0L) ?: return null
                    val publish = when (parts[3]) {
                        "1" -> true
                        "0" -> false
                        else -> return null
                    }
                    val name = decodeBase64(parts[4]) ?: return null
                    val destination = decodeBase64(parts[5]) ?: return null
                    return Native(
                        id = id,
                        name = name,
                        destinationUri = destination,
                        expectedBytes = expectedBytes,
                        publishOnComplete = publish,
                    )
                }

                val parts = raw.split(':', limit = 2)
                val id = parts.getOrNull(0)?.toLongOrNull() ?: return null
                val encodedName = parts.getOrNull(1)?.takeIf(String::isNotBlank) ?: return null
                val name = decodeBase64(encodedName) ?: return null
                return LegacyDownloadManager(id, name)
            }

            private fun encodeBase64(value: String): String = Base64.encodeToString(
                value.toByteArray(Charsets.UTF_8),
                Base64.NO_WRAP,
            )

            private fun decodeBase64(value: String): String? = runCatching {
                String(Base64.decode(value, Base64.NO_WRAP), Charsets.UTF_8)
            }.getOrNull()
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "nova_transfer_catalog"
        const val KEY_RECORDS = "records"
        const val NATIVE_RECORD_PREFIX = "native"
        const val MAX_RETAINED_TASKS = 100
        const val MAX_FILE_NAME_CHARS = 120
        const val DEFAULT_FILE_NAME = "download"
        const val DEFAULT_NATIVE_CONNECTIONS = 8
    }
}
