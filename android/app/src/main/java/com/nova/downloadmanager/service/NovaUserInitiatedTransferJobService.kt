package com.nova.downloadmanager.service

import android.app.job.JobParameters
import android.app.job.JobService

/**
 * Android 14+ user-initiated-transfer entry point.
 *
 * This service deliberately owns scheduling lifecycle only. The download state
 * machine and transfer implementation stay in the shared Rust core; a later
 * integration milestone will hand a durable task ID to that core session.
 */
class NovaUserInitiatedTransferJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        // No Kotlin download engine is permitted. Until the Rust task-session
        // handoff is packaged, terminate without rescheduling rather than
        // pretending to perform a transfer.
        jobFinished(params, false)
        return false
    }

    override fun onStopJob(params: JobParameters): Boolean {
        // When a real core task is attached, this will persist a stop reason
        // and return true only for policy-approved retryable work.
        return true
    }
}
