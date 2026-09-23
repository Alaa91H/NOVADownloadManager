package com.nova.downloadmanager.service

import android.app.job.JobParameters
import android.app.job.JobService
import com.nova.downloadmanager.downloads.NovaTransferCore

/**
 * Android 14+ user-initiated-transfer lifecycle entry point.
 *
 * Direct network bytes now flow through NOVA's shared Rust core. This service
 * remains a lifecycle reconciliation boundary only; Android-compliant UIDT
 * execution and notification actions are enabled in the next milestone after
 * the native transfer session is validated on device.
 */
class NovaUserInitiatedTransferJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        runCatching { NovaTransferCore(applicationContext).reconcile() }
        jobFinished(params, false)
        return false
    }

    override fun onStopJob(params: JobParameters): Boolean = false
}
