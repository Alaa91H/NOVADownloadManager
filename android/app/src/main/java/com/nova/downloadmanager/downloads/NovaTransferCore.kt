package com.nova.downloadmanager.downloads

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.util.Base64

/**
 * NOVA-owned Android transfer-task core.
 *
 * Android DownloadManager performs the network transfer so normal HTTP(S) work
 * remains durable under Android's background policy. NOVA owns the accepted
 * task catalog, safe destination choice, status projection, and restoration
 * after the Compose activity is recreated. Only a system download id and a
 * display name are persisted; URLs, request headers, cookies, and tokens are
 * deliberately not written to the local task catalog.
 */
class NovaTransferCore(context: Context) {
    private val appContext = context.applicationContext
    private val downloadManager = requireNotNull(
        appContext.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager,
    ) { "Android download service is unavailable" }
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun enqueue(url: String): Result<DownloadSummary> = runCatching {
        val source = Uri.parse(url.trim())
        require(source.scheme.equals("http", ignoreCase = true) || source.scheme.equals("https", ignoreCase = true)) {
            "Only HTTP(S) download URLs are supported"
        }
        require(!source.host.isNullOrBlank()) { "A download host is required" }

        val fileName = safeFileName(source)
        val request = DownloadManager.Request(source)
            .setTitle(fileName)
            .setDescription(source.host)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "NOVA/$fileName")
            .setAllowedOverMetered(true)
            .setAllowedOverRoaming(false)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)

        val id = downloadManager.enqueue(request)
        remember(TransferRecord(id, fileName))
        DownloadSummary(
            id = id.toString(),
            name = fileName,
            status = DownloadStatus.Queued.wireValue,
            downloadedBytes = 0,
            totalBytes = 0,
        )
    }

    fun restore(): List<DownloadSummary> = records().mapNotNull { record -> query(record) }

    fun refresh(taskIds: Collection<String>): List<DownloadSummary> {
        val requested = taskIds.mapNotNull(String::toLongOrNull).toSet()
        return records()
            .filter { requested.isEmpty() || it.id in requested }
            .mapNotNull(::query)
    }

    /** Invoked by the transfer lifecycle job whenever Android schedules it. */
    fun reconcile(): List<DownloadSummary> = restore()

    private fun query(record: TransferRecord): DownloadSummary? {
        val cursor = downloadManager.query(DownloadManager.Query().setFilterById(record.id)) ?: return null
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
                id = record.id.toString(),
                name = name,
                status = status.wireValue,
                downloadedBytes = it.getLong(it.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                    .coerceAtLeast(0),
                totalBytes = it.getLong(it.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                    .coerceAtLeast(0),
            )
        }
    }

    private fun remember(record: TransferRecord) {
        val next = (records() + record)
            .distinctBy(TransferRecord::id)
            .sortedByDescending(TransferRecord::id)
            .take(MAX_RETAINED_TASKS)
            .map(TransferRecord::encode)
            .toSet()
        preferences.edit().putStringSet(KEY_RECORDS, next).apply()
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

    private data class TransferRecord(val id: Long, val name: String) {
        fun encode(): String = "$id:${Base64.encodeToString(name.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)}"

        companion object {
            fun decode(raw: String): TransferRecord? {
                val (id, encodedName) = raw.split(':', limit = 2).let {
                    it.getOrNull(0)?.toLongOrNull() to it.getOrNull(1)
                }
                if (id == null || encodedName.isNullOrBlank()) return null
                return runCatching {
                    TransferRecord(id, String(Base64.decode(encodedName, Base64.NO_WRAP), Charsets.UTF_8))
                }.getOrNull()
            }
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "nova_transfer_catalog"
        const val KEY_RECORDS = "records"
        const val MAX_RETAINED_TASKS = 100
        const val MAX_FILE_NAME_CHARS = 120
        const val DEFAULT_FILE_NAME = "download"
    }
}
