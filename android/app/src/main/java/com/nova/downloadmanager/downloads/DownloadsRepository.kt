package com.nova.downloadmanager.downloads

/**
 * Boundary owned by Android application code. Its production implementation
 * will call the versioned UniFFI bridge only; it must never implement transfer
 * scheduling, segmenting, retries, or byte I/O in Kotlin.
 */
interface DownloadsRepository {
    fun coreReadiness(): CoreReadiness
}

/**
 * Foundation implementation used until the Rust Android library and generated
 * UniFFI bindings are packaged into the app module.
 */
class UnpackagedRustDownloadsRepository : DownloadsRepository {
    override fun coreReadiness(): CoreReadiness = CoreReadiness.BridgeNotPackaged
}
