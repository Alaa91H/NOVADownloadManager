package com.nova.downloadmanager.downloads

import android.content.Context

/**
 * UI boundary for the Android transfer core. Implementations own no browser
 * credentials: accepted direct HTTP(S) tasks are delegated to NOVA's local
 * task catalog and NOVA's shared Rust transfer core.
 */
interface DownloadsRepository {
    fun coreReadiness(): CoreReadiness
    fun enqueue(url: String): Result<DownloadSummary>
    fun pause(taskId: String): Result<DownloadSummary> = unsupported("pause")
    fun resume(taskId: String): Result<DownloadSummary> = unsupported("resume")
    fun cancel(taskId: String): Result<DownloadSummary> = unsupported("cancel")
    fun restore(): List<DownloadSummary> = emptyList()
    fun refresh(taskIds: Collection<String>): List<DownloadSummary>

    private fun unsupported(action: String): Result<DownloadSummary> = Result.failure(
        IllegalStateException("NOVA transfer action is unavailable: $action"),
    )
}

/**
 * Deterministic test/fallback boundary used only before an application Context
 * is attached. It never claims a transfer has started.
 */
class UnpackagedRustDownloadsRepository : DownloadsRepository {
    override fun coreReadiness(): CoreReadiness = CoreReadiness.BridgeNotPackaged

    override fun enqueue(url: String): Result<DownloadSummary> = Result.failure(
        IllegalStateException("Android download service is unavailable"),
    )

    override fun refresh(taskIds: Collection<String>): List<DownloadSummary> = emptyList()
}

/**
 * Application-facing adapter for the NOVA-owned Android task core.
 */
class PlatformDownloadsRepository(context: Context) : DownloadsRepository {
    private val core = NovaTransferCore(context)

    override fun coreReadiness(): CoreReadiness = CoreReadiness.Ready

    override fun enqueue(url: String): Result<DownloadSummary> = core.enqueue(url)

    override fun pause(taskId: String): Result<DownloadSummary> = core.pause(taskId)

    override fun resume(taskId: String): Result<DownloadSummary> = core.resume(taskId)

    override fun cancel(taskId: String): Result<DownloadSummary> = core.cancel(taskId)

    override fun restore(): List<DownloadSummary> = core.restore()

    override fun refresh(taskIds: Collection<String>): List<DownloadSummary> = core.refresh(taskIds)
}

enum class DownloadStatus(val wireValue: String) {
    Queued("queued"),
    Downloading("downloading"),
    Paused("paused"),
    Completed("completed"),
    Failed("failed"),
    Cancelled("cancelled"),
}
