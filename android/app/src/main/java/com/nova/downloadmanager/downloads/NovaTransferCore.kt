package com.nova.downloadmanager.downloads

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.ContextCompat
import com.nova.downloadmanager.core.NovaNativeCore
import com.nova.downloadmanager.service.NovaNativeTransferService
import java.io.File
import java.net.URLConnection

/**
 * Android host adapter for NOVA's native Rust transfer engine.
 *
 * Kotlin owns Android lifecycle and destination integration only. HTTP I/O,
 * progress accounting, cancellation and transfer state are owned by Rust.
 * URLs are deliberately not persisted in the Android task catalog so signed
 * links, cookies and query tokens are not left in SharedPreferences.
 */
class NovaTransferCore(context: Context) {
    private val appContext = context.applicationContext
    private val nativeBridgeApiVersion = NovaNativeCore.requireCompatible()
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun enqueue(url: String): Result<DownloadSummary> = runCatching {
        check(nativeBridgeApiVersion > 0) { "NOVA native core is not initialized" }

        val source = Uri.parse(url.trim())
        require(source.scheme.equals("http", ignoreCase = true) || source.scheme.equals("https", ignoreCase = true)) {
            "Only HTTP(S) download URLs are supported"
        }
        require(!source.host.isNullOrBlank()) { "A download host is required" }

        val fileName = safeFileName(source)
        val destination = createDestination(fileName)
        val taskId = try {
            destination.descriptor.use { descriptor ->
                NovaNativeCore.startHttpTransfer(source.toString(), descriptor.fd)
            }
        } catch (failure: Throwable) {
            cleanupDestination(destination.uri)
            throw failure
        }

        val record = TransferRecord(
            id = taskId,
            name = fileName,
            destinationUri = destination.uri.toString(),
            status = DownloadStatus.Queued.wireValue,
            downloadedBytes = 0,
            totalBytes = 0,
            destinationFinalized = false,
        )
        remember(record)
        startLifecycleService()

        record.toSummary()
    }

    fun restore(): List<DownloadSummary> = reconcileRecords()

    fun refresh(taskIds: Collection<String>): List<DownloadSummary> {
        val requested = taskIds.mapNotNull(String::toLongOrNull).toSet()
        return reconcileRecords().filter { summary ->
            requested.isEmpty() || summary.id.toLongOrNull()?.let(requested::contains) == true
        }
    }

    /** Invoked by Android lifecycle services while native tasks are active. */
    fun reconcile(): List<DownloadSummary> = reconcileRecords()

    private fun reconcileRecords(): List<DownloadSummary> {
        val current = records()
        if (current.isEmpty()) return emptyList()

        val updated = current.map(::reconcileRecord)
        writeRecords(updated)
        return updated.map(TransferRecord::toSummary)
    }

    private fun reconcileRecord(record: TransferRecord): TransferRecord {
        if (record.status in TERMINAL_STATUSES && record.destinationFinalized) {
            return record
        }

        val snapshot = runCatching { NovaNativeCore.transferSnapshot(record.id) }.getOrNull()
        if (snapshot == null) {
            // A process-local Rust task cannot survive process death yet. Keep
            // the catalog truthful and remove any uncommitted destination.
            if (record.status !in TERMINAL_STATUSES) {
                val finalized = finalizeDestination(record, DownloadStatus.Failed.wireValue)
                return record.copy(
                    status = DownloadStatus.Failed.wireValue,
                    destinationFinalized = finalized,
                )
            }
            return record
        }

        val status = snapshot.status.wireValue
        var finalized = record.destinationFinalized
        if (status in TERMINAL_STATUSES && !finalized) {
            finalized = finalizeDestination(record, status)
        }
        if (status in TERMINAL_STATUSES && finalized) {
            runCatching { NovaNativeCore.forgetTransfer(record.id) }
        }

        return record.copy(
            status = status,
            downloadedBytes = snapshot.downloadedBytes.coerceAtLeast(0),
            totalBytes = snapshot.totalBytes.coerceAtLeast(0),
            destinationFinalized = finalized,
        )
    }

    private fun finalizeDestination(record: TransferRecord, status: String): Boolean = runCatching {
        val uri = Uri.parse(record.destinationUri)
        if (status == DownloadStatus.Completed.wireValue) {
            publishDestination(uri)
        } else {
            cleanupDestination(uri)
        }
    }.isSuccess

    private fun createDestination(fileName: String): TransferDestination {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = appContext.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                put(
                    MediaStore.MediaColumns.MIME_TYPE,
                    URLConnection.guessContentTypeFromName(fileName) ?: DEFAULT_MIME_TYPE,
                )
                put(
                    MediaStore.MediaColumns.RELATIVE_PATH,
                    "${Environment.DIRECTORY_DOWNLOADS}/$DESTINATION_DIRECTORY",
                )
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = checkNotNull(
                resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values),
            ) { "Android could not create the NOVA download destination" }
            val descriptor = resolver.openFileDescriptor(uri, "rw")
            if (descriptor == null) {
                resolver.delete(uri, null, null)
                error("Android could not open the NOVA download destination")
            }
            return TransferDestination(uri, descriptor)
        }

        val root = appContext.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: appContext.filesDir
        val directory = File(root, DESTINATION_DIRECTORY).apply { mkdirs() }
        val file = uniqueFile(directory, fileName)
        val descriptor = ParcelFileDescriptor.open(
            file,
            ParcelFileDescriptor.MODE_CREATE or
                ParcelFileDescriptor.MODE_READ_WRITE or
                ParcelFileDescriptor.MODE_TRUNCATE,
        )
        return TransferDestination(Uri.fromFile(file), descriptor)
    }

    private fun publishDestination(uri: Uri) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || uri.scheme != "content") return
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.IS_PENDING, 0)
        }
        check(appContext.contentResolver.update(uri, values, null, null) > 0) {
            "Android could not publish the completed NOVA download"
        }
    }

    private fun cleanupDestination(uri: Uri) {
        when (uri.scheme) {
            "content" -> appContext.contentResolver.delete(uri, null, null)
            "file" -> uri.path?.let(::File)?.delete()
        }
    }

    private fun startLifecycleService() {
        runCatching {
            ContextCompat.startForegroundService(
                appContext,
                Intent(appContext, NovaNativeTransferService::class.java),
            )
        }
    }

    private fun remember(record: TransferRecord) {
        val next = (records() + record)
            .distinctBy(TransferRecord::id)
            .sortedByDescending(TransferRecord::id)
            .take(MAX_RETAINED_TASKS)
        writeRecords(next)
    }

    private fun writeRecords(records: List<TransferRecord>) {
        preferences.edit()
            .putStringSet(KEY_RECORDS, records.map(TransferRecord::encode).toSet())
            .apply()
    }

    private fun records(): List<TransferRecord> = preferences
        .getStringSet(KEY_RECORDS, emptySet())
        .orEmpty()
        .mapNotNull(TransferRecord::decode)
        .sortedByDescending(TransferRecord::id)

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

    private fun uniqueFile(directory: File, fileName: String): File {
        val preferred = File(directory, fileName)
        if (!preferred.exists()) return preferred

        val dot = fileName.lastIndexOf('.')
        val stem = if (dot > 0) fileName.substring(0, dot) else fileName
        val extension = if (dot > 0) fileName.substring(dot) else ""
        for (index in 1..MAX_NAME_COLLISION_ATTEMPTS) {
            val candidate = File(directory, "$stem ($index)$extension")
            if (!candidate.exists()) return candidate
        }
        return File(directory, "$stem-${System.currentTimeMillis()}$extension")
    }

    private data class TransferDestination(
        val uri: Uri,
        val descriptor: ParcelFileDescriptor,
    )

    private data class TransferRecord(
        val id: Long,
        val name: String,
        val destinationUri: String,
        val status: String,
        val downloadedBytes: Long,
        val totalBytes: Long,
        val destinationFinalized: Boolean,
    ) {
        fun toSummary(): DownloadSummary = DownloadSummary(
            id = id.toString(),
            name = name,
            status = status,
            downloadedBytes = downloadedBytes,
            totalBytes = totalBytes,
        )

        fun encode(): String = listOf(
            RECORD_VERSION,
            id.toString(),
            encodeField(name),
            encodeField(destinationUri),
            status,
            downloadedBytes.toString(),
            totalBytes.toString(),
            if (destinationFinalized) "1" else "0",
        ).joinToString(RECORD_SEPARATOR)

        companion object {
            fun decode(raw: String): TransferRecord? {
                val fields = raw.split(RECORD_SEPARATOR)
                if (fields.size != RECORD_FIELD_COUNT || fields[0] != RECORD_VERSION) return null
                val id = fields[1].toLongOrNull()?.takeIf { it > 0 } ?: return null
                val name = decodeField(fields[2]) ?: return null
                val destination = decodeField(fields[3]) ?: return null
                val status = fields[4].takeIf { it in KNOWN_STATUSES } ?: return null
                val downloaded = fields[5].toLongOrNull()?.coerceAtLeast(0) ?: return null
                val total = fields[6].toLongOrNull()?.coerceAtLeast(0) ?: return null
                val finalized = when (fields[7]) {
                    "1" -> true
                    "0" -> false
                    else -> return null
                }
                return TransferRecord(
                    id = id,
                    name = name,
                    destinationUri = destination,
                    status = status,
                    downloadedBytes = downloaded,
                    totalBytes = total,
                    destinationFinalized = finalized,
                )
            }

            private fun encodeField(value: String): String =
                Base64.encodeToString(value.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)

            private fun decodeField(value: String): String? = runCatching {
                String(Base64.decode(value, Base64.NO_WRAP), Charsets.UTF_8)
            }.getOrNull()
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "nova_transfer_catalog"
        const val KEY_RECORDS = "records"
        const val RECORD_VERSION = "2"
        const val RECORD_SEPARATOR = "|"
        const val RECORD_FIELD_COUNT = 8
        const val MAX_RETAINED_TASKS = 100
        const val MAX_FILE_NAME_CHARS = 120
        const val MAX_NAME_COLLISION_ATTEMPTS = 999
        const val DEFAULT_FILE_NAME = "download"
        const val DEFAULT_MIME_TYPE = "application/octet-stream"
        const val DESTINATION_DIRECTORY = "NOVA"

        val TERMINAL_STATUSES = setOf(
            DownloadStatus.Completed.wireValue,
            DownloadStatus.Failed.wireValue,
        )
        val KNOWN_STATUSES = DownloadStatus.entries.map(DownloadStatus::wireValue).toSet()
    }
}
