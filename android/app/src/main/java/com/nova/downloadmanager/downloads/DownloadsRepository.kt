package com.nova.downloadmanager.downloads

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import java.util.Locale

/**
 * Boundary owned by the Android application. Direct HTTP(S) transfers use the
 * platform download manager so that an accepted download continues outside the
 * Compose activity and participates in Android's notification lifecycle.
 */
interface DownloadsRepository {
    fun coreReadiness(): CoreReadiness
    fun enqueue(url: String): Result<DownloadSummary>
    fun refresh(taskIds: Collection<String>): List<DownloadSummary>
}

/**
 * Kept as a deterministic test and fallback boundary. The production activity
 * replaces it with [PlatformDownloadsRepository] after it has a valid Context.
 */
class UnpackagedRustDownloadsRepository : DownloadsRepository {
    override fun coreReadiness(): CoreReadiness = CoreReadiness.BridgeNotPackaged

    override fun enqueue(url: String): Result<DownloadSummary> = Result.failure(
        IllegalStateException("Android download service is unavailable"),
    )

    override fun refresh(taskIds: Collection<String>): List<DownloadSummary> = emptyList()
}

class PlatformDownloadsRepository(context: Context) : DownloadsRepository {
    private val appContext = context.applicationContext
    private val downloadManager = requireNotNull(
        appContext.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager,
    ) { "Android download service is unavailable" }

    override fun coreReadiness(): CoreReadiness = CoreReadiness.Ready

    override fun enqueue(url: String): Result<DownloadSummary> = runCatching {
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
        DownloadSummary(
            id = id.toString(),
            name = fileName,
            status = DownloadStatus.Queued.wireValue,
            downloadedBytes = 0,
            totalBytes = 0,
        )
    }

    override fun refresh(taskIds: Collection<String>): List<DownloadSummary> = buildList {
        taskIds.mapNotNullTo(this) { id ->
            id.toLongOrNull()?.let(::query)
        }
    }

    private fun query(id: Long): DownloadSummary? {
        val cursor = downloadManager.query(DownloadManager.Query().setFilterById(id)) ?: return null
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
                ?: "download"
            val downloaded = it.getLong(it.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                .coerceAtLeast(0)
            val total = it.getLong(it.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                .coerceAtLeast(0)
            return DownloadSummary(
                id = id.toString(),
                name = name,
                status = status.wireValue,
                downloadedBytes = downloaded,
                totalBytes = total,
            )
        }
    }

    private fun safeFileName(uri: Uri): String {
        val raw = uri.lastPathSegment
            ?.substringAfterLast('/')
            ?.takeIf(String::isNotBlank)
            ?: "download"
        val sanitized = raw.replace(Regex("[^A-Za-z0-9._-]"), "_")
            .trim('.', '_')
            .take(120)
        return sanitized.ifBlank { "download" }.lowercase(Locale.ROOT)
    }
}

enum class DownloadStatus(val wireValue: String) {
    Queued("queued"),
    Downloading("downloading"),
    Paused("paused"),
    Completed("completed"),
    Failed("failed"),
}
