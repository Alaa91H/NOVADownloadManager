package com.nova.downloadmanager.service

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.nova.downloadmanager.downloads.DownloadSummary
import com.nova.downloadmanager.downloads.NovaTransferCore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay

/**
 * Android 13 and lower fallback for long-running user-visible transfers.
 *
 * The Worker owns lifecycle/foreground policy; the blocking network transfer
 * itself remains inside the shared Rust core.
 */
class NovaTransferWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
    @Volatile
    private var activeTaskId: String? = null

    override suspend fun doWork(): Result = coroutineScope {
        val taskId = inputData.getString(NovaTransferScheduler.EXTRA_TASK_ID)
            ?.takeIf(String::isNotBlank)
            ?: return@coroutineScope Result.failure()

        val core = runCatching { NovaTransferCore(applicationContext) }
            .getOrElse { return@coroutineScope Result.failure() }
        val initial = core.task(taskId) ?: return@coroutineScope Result.failure()

        activeTaskId = taskId
        setForeground(foregroundInfo(initial))

        val transfer = async(Dispatchers.IO) {
            core.execute(taskId)
        }

        while (!transfer.isCompleted) {
            delay(PROGRESS_UPDATE_INTERVAL_MS)
            (core.checkpointProgress(taskId) ?: core.task(taskId))?.let { summary ->
                setProgress(
                    workDataOf(
                        PROGRESS_DOWNLOADED_BYTES to summary.downloadedBytes,
                        PROGRESS_TOTAL_BYTES to summary.totalBytes,
                        PROGRESS_STATUS to summary.status,
                    ),
                )
                setForeground(foregroundInfo(summary))
            }
        }

        val outcome = transfer.await()
        activeTaskId = null
        val summary = core.task(taskId)
        if (summary != null) {
            setForeground(foregroundInfo(summary))
        }

        outcome.fold(
            onSuccess = { completed ->
                when (completed.status) {
                    "completed", "paused", "cancelled" -> Result.success()
                    "failed" -> if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.failure()
                    else -> Result.success()
                }
            },
            onFailure = {
                if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.failure()
            },
        )
    }

    override fun onStopped() {
        activeTaskId?.let { taskId ->
            runCatching { NovaTransferCore(applicationContext).pause(taskId) }
        }
        activeTaskId = null
        super.onStopped()
    }

    private fun foregroundInfo(summary: DownloadSummary): ForegroundInfo {
        val notification = NovaTransferNotifications.build(applicationContext, summary)
        val id = NovaTransferNotifications.notificationId(summary.id)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(id, notification)
        }
    }

    private companion object {
        const val PROGRESS_UPDATE_INTERVAL_MS = 1_000L
        const val MAX_RETRIES = 2
        const val PROGRESS_DOWNLOADED_BYTES = "downloaded_bytes"
        const val PROGRESS_TOTAL_BYTES = "total_bytes"
        const val PROGRESS_STATUS = "status"
    }
}
