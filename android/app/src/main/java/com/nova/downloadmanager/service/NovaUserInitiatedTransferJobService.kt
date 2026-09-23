package com.nova.downloadmanager.service

import android.app.NotificationManager
import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Build
import com.nova.downloadmanager.downloads.NovaTransferCore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Android 14+ owner for user-initiated transfer execution.
 *
 * JobScheduler owns the long-running lifecycle. The service posts the required
 * job notification immediately, invokes the persisted task through Rust on a
 * background executor, and periodically reports transferred bytes back to the
 * scheduler and notification surface.
 */
class NovaUserInitiatedTransferJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        val taskId = params.extras.getString(NovaTransferScheduler.EXTRA_TASK_ID)
            ?.takeIf(String::isNotBlank)
            ?: return false
        val core = runCatching { NovaTransferCore(applicationContext) }.getOrNull()
            ?: return false
        val initial = core.task(taskId) ?: return false

        NovaTransferNotifications.ensureChannel(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            setNotification(
                params,
                NovaTransferNotifications.notificationId(taskId),
                NovaTransferNotifications.build(this, initial),
                JOB_END_NOTIFICATION_POLICY_DETACH,
            )
        }

        val baselineDownloadedBytes = initial.downloadedBytes
        STOPPED_JOBS.remove(params.jobId)
        val monitor = MONITOR_EXECUTOR.scheduleAtFixedRate(
            {
                val summary = core.task(taskId) ?: return@scheduleAtFixedRate
                getSystemService(NotificationManager::class.java)?.notify(
                    NovaTransferNotifications.notificationId(taskId),
                    NovaTransferNotifications.build(this, summary),
                )
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    updateTransferredNetworkBytes(
                        params,
                        (summary.downloadedBytes - baselineDownloadedBytes).coerceAtLeast(0L),
                        0L,
                    )
                }
            },
            PROGRESS_UPDATE_INTERVAL_SECONDS,
            PROGRESS_UPDATE_INTERVAL_SECONDS,
            TimeUnit.SECONDS,
        )

        val execution = TRANSFER_EXECUTOR.submit {
            try {
                core.execute(taskId)
            } finally {
                monitor.cancel(false)
                ACTIVE_MONITORS.remove(params.jobId)
                ACTIVE_EXECUTIONS.remove(params.jobId)
                val finalSummary = core.task(taskId)
                if (finalSummary != null) {
                    val manager = getSystemService(NotificationManager::class.java)
                    val notificationId = NovaTransferNotifications.notificationId(taskId)
                    when (finalSummary.status) {
                        "paused", "failed" -> manager?.notify(
                            notificationId,
                            NovaTransferNotifications.build(this, finalSummary),
                        )
                        "completed", "cancelled" -> manager?.cancel(notificationId)
                    }
                }
                if (!STOPPED_JOBS.remove(params.jobId)) {
                    jobFinished(params, false)
                }
            }
        }
        ACTIVE_EXECUTIONS[params.jobId] = execution
        ACTIVE_MONITORS[params.jobId] = monitor
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        val taskId = params.extras.getString(NovaTransferScheduler.EXTRA_TASK_ID)
            ?.takeIf(String::isNotBlank)
        if (taskId != null) {
            runCatching {
                val core = NovaTransferCore(applicationContext)
                val status = core.task(taskId)?.status
                if (status == "queued" || status == "downloading") {
                    core.pause(taskId)
                }
            }
        }

        STOPPED_JOBS.add(params.jobId)
        ACTIVE_MONITORS.remove(params.jobId)?.cancel(false)
        ACTIVE_EXECUTIONS.remove(params.jobId)
        // Never auto-reschedule a stopped UIDT job. A user can explicitly
        // resume the durable paused task from NOVA.
        return false
    }

    private companion object {
        const val PROGRESS_UPDATE_INTERVAL_SECONDS = 1L
        val TRANSFER_EXECUTOR = Executors.newCachedThreadPool { runnable ->
            Thread(runnable, "nova-uidt-transfer").apply { isDaemon = true }
        }
        val MONITOR_EXECUTOR = Executors.newScheduledThreadPool(1) { runnable ->
            Thread(runnable, "nova-uidt-progress").apply { isDaemon = true }
        }
        val ACTIVE_EXECUTIONS = ConcurrentHashMap<Int, java.util.concurrent.Future<*>>()
        val ACTIVE_MONITORS = ConcurrentHashMap<Int, ScheduledFuture<*>>()
        val STOPPED_JOBS = ConcurrentHashMap.newKeySet<Int>()
    }
}
