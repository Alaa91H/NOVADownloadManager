package com.nova.downloadmanager.downloads

import android.content.Context

/**
 * UI boundary for the Android transfer core. Implementations own no browser
 * credentials: accepted direct HTTP(S) tasks are delegated to NOVA's local
 * task catalog and Android's durable system transfer facility.
 */
interface DownloadsRepository {
    fun coreReadiness(): CoreReadiness
    fun enqueue(url: String): Result<DownloadSummary>
    fun restore(): List<DownloadSummary> = emptyList()
    fun refresh(taskIds: Collection<String>): List<DownloadSummary>
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

    override fun restore(): List<DownloadSummary> = core.restore()

    override fun refresh(taskIds: Collection<String>): List<DownloadSummary> = core.refresh(taskIds)
}

enum class DownloadStatus(val wireValue: String) {
    Queued("queued"),
    Downloading("downloading"),
    Paused("paused"),
    Completed("completed"),
    Failed("failed"),
}
