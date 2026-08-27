package com.nova.downloadmanager.service

import android.app.job.JobParameters
import android.app.job.JobService
import com.nova.downloadmanager.downloads.NovaTransferCore

/**
 * Android 14+ user-initiated-transfer lifecycle entry point.
 *
 * The network transfer is performed by Android DownloadManager under the
 * platform's durable data-sync policy. NOVA owns and reconciles the local task
 * catalog here so that scheduled lifecycle entry does not pretend to be a
 * transfer while still keeping accepted tasks observable after process restart.
 */
class NovaUserInitiatedTransferJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        runCatching { NovaTransferCore(applicationContext).reconcile() }
        jobFinished(params, false)
        return false
    }

    override fun onStopJob(params: JobParameters): Boolean = false
}
