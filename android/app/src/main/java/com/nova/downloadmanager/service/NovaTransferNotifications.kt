package com.nova.downloadmanager.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.text.format.Formatter
import androidx.core.app.NotificationCompat
import com.nova.downloadmanager.R
import com.nova.downloadmanager.app.MainActivity
import com.nova.downloadmanager.downloads.DownloadSummary

internal object NovaTransferNotifications {
    const val CHANNEL_ID = "nova_transfers"
    const val ACTION_PAUSE = "com.nova.downloadmanager.action.PAUSE_TRANSFER"
    const val ACTION_CANCEL = "com.nova.downloadmanager.action.CANCEL_TRANSFER"
    const val ACTION_RESUME = "com.nova.downloadmanager.action.RESUME_TRANSFER"

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.nova_navigation_downloads),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.nova_download_empty_detail)
                setShowBadge(false)
            },
        )
    }

    fun notificationId(taskId: String): Int =
        (NovaTransferScheduler.jobId(taskId) xor 0x1357_2468).coerceAtLeast(1)

    fun build(context: Context, summary: DownloadSummary): Notification {
        ensureChannel(context)

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_nova_download_notification)
            .setContentTitle(summary.name)
            .setContentText(progressText(context, summary))
            .setOnlyAlertOnce(true)
            .setOngoing(summary.status in ACTIVE_STATUSES)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(openAppIntent(context))

        if (summary.totalBytes > 0L && summary.status in ACTIVE_STATUSES) {
            val progress = ((summary.downloadedBytes.coerceAtMost(summary.totalBytes) * 100L) /
                summary.totalBytes).toInt()
            builder.setProgress(100, progress, false)
        } else if (summary.status in ACTIVE_STATUSES) {
            builder.setProgress(0, 0, true)
        } else {
            builder.setProgress(0, 0, false)
        }

        when (summary.status) {
            "queued", "downloading" -> {
                builder.addAction(
                    0,
                    context.getString(R.string.nova_status_paused),
                    broadcastAction(context, summary.id, ACTION_PAUSE),
                )
                builder.addAction(
                    0,
                    context.getString(R.string.nova_action_cancel),
                    broadcastAction(context, summary.id, ACTION_CANCEL),
                )
            }
            "paused", "failed" -> {
                builder.setOngoing(false)
                builder.addAction(
                    0,
                    context.getString(R.string.nova_action_refresh),
                    resumeInAppAction(context, summary.id),
                )
                builder.addAction(
                    0,
                    context.getString(R.string.nova_action_cancel),
                    broadcastAction(context, summary.id, ACTION_CANCEL),
                )
            }
        }

        return builder.build()
    }

    private fun progressText(context: Context, summary: DownloadSummary): String {
        val status = when (summary.status) {
            "queued" -> context.getString(R.string.nova_filter_queue)
            "downloading" -> context.getString(R.string.nova_filter_active)
            "paused" -> context.getString(R.string.nova_status_paused)
            "completed" -> context.getString(R.string.nova_filter_completed)
            "cancelled" -> context.getString(R.string.nova_action_cancel)
            else -> context.getString(R.string.nova_status_error)
        }
        val downloaded = Formatter.formatFileSize(context, summary.downloadedBytes)
        val total = summary.totalBytes
            .takeIf { it > 0L }
            ?.let { Formatter.formatFileSize(context, it) }

        return if (total != null) "$status · $downloaded / $total" else "$status · $downloaded"
    }

    private fun openAppIntent(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun resumeInAppAction(context: Context, taskId: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_RESUME
            putExtra(NovaTransferScheduler.EXTRA_TASK_ID, taskId)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            NovaTransferScheduler.jobId(taskId),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun broadcastAction(context: Context, taskId: String, action: String): PendingIntent {
        val intent = Intent(context, NovaTransferActionReceiver::class.java).apply {
            this.action = action
            putExtra(NovaTransferScheduler.EXTRA_TASK_ID, taskId)
        }
        val actionSalt = if (action == ACTION_PAUSE) 0x1000_0000 else 0x2000_0000
        return PendingIntent.getBroadcast(
            context,
            NovaTransferScheduler.jobId(taskId) xor actionSalt,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private val ACTIVE_STATUSES = setOf("queued", "downloading")
}
