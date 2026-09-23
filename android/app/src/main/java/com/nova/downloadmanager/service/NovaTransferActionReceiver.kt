package com.nova.downloadmanager.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.nova.downloadmanager.downloads.NovaTransferCore

/**
 * Notification actions never perform network transfer themselves. They only
 * signal the active Rust session and cancel the OS execution envelope.
 */
class NovaTransferActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(NovaTransferScheduler.EXTRA_TASK_ID)
            ?.takeIf(String::isNotBlank)
            ?: return
        val core = runCatching { NovaTransferCore(context.applicationContext) }.getOrNull() ?: return

        when (intent.action) {
            NovaTransferNotifications.ACTION_PAUSE -> {
                core.pause(taskId)
                NovaTransferScheduler.cancel(context, taskId)
            }
            NovaTransferNotifications.ACTION_CANCEL -> {
                core.cancel(taskId)
                NovaTransferScheduler.cancel(context, taskId)
            }
        }
    }
}
