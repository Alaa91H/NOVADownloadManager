package com.nova.downloadmanager.service

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf

/**
 * Owns Android execution policy for persisted NOVA transfer tasks.
 *
 * Android 14+ uses a user-initiated data-transfer JobScheduler job. Older
 * releases use a long-running WorkManager worker with an equivalent network
 * constraint and foreground notification.
 */
internal object NovaTransferScheduler {
    const val EXTRA_TASK_ID = "nova.task_id"
    private const val WORK_NAME_PREFIX = "nova-transfer-"

    fun schedule(context: Context, taskId: String): Result<Unit> = runCatching {
        require(taskId.isNotBlank()) { "taskId must not be blank" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            scheduleUserInitiatedJob(context.applicationContext, taskId)
        } else {
            scheduleWorkManager(context.applicationContext, taskId)
        }
    }

    fun cancel(context: Context, taskId: String) {
        val appContext = context.applicationContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            (appContext.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler)
                ?.cancel(jobId(taskId))
        }
        WorkManager.getInstance(appContext).cancelUniqueWork(workName(taskId))
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun scheduleUserInitiatedJob(context: Context, taskId: String) {
        val scheduler = requireNotNull(
            context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler,
        ) { "Android JobScheduler is unavailable" }

        val extras = PersistableBundle().apply {
            putString(EXTRA_TASK_ID, taskId)
        }
        val job = JobInfo.Builder(
            jobId(taskId),
            ComponentName(context, NovaUserInitiatedTransferJobService::class.java),
        )
            .setExtras(extras)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setEstimatedNetworkBytes(JobInfo.NETWORK_BYTES_UNKNOWN.toLong(), 0L)
            .setUserInitiated(true)
            .build()

        check(scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS) {
            "Android rejected the user-initiated transfer job"
        }
    }

    private fun scheduleWorkManager(context: Context, taskId: String) {
        val request = OneTimeWorkRequestBuilder<NovaTransferWorker>()
            .setInputData(workDataOf(EXTRA_TASK_ID to taskId))
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .addTag(workName(taskId))
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(
            workName(taskId),
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    fun jobId(taskId: String): Int {
        val compact = taskId.filterNot { it == '-' }
        val prefix = compact.take(7)
        return prefix.toIntOrNull(16)?.coerceAtLeast(1)
            ?: (taskId.hashCode() and 0x0FFF_FFFF).coerceAtLeast(1)
    }

    private fun workName(taskId: String): String = WORK_NAME_PREFIX + taskId
}
