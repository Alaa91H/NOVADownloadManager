package com.nova.downloadmanager.service

import android.app.job.JobParameters
import android.app.job.JobService
import com.nova.downloadmanager.downloads.NovaTransferCore

/**
 * Android 14+ user-initiated-transfer lifecycle entry point.
 *
 * Network bytes are transferred by NOVA's Rust/libcurl engine. This scheduled
 * entry point only reconciles Android-side task metadata; the foreground
 * NovaNativeTransferService owns the live data-sync process lifetime.
 */
class NovaUserInitiatedTransferJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        runCatching { NovaTransferCore(applicationContext).reconcile() }
        jobFinished(params, false)
        return false
    }

    override fun onStopJob(params: JobParameters): Boolean = false
}
