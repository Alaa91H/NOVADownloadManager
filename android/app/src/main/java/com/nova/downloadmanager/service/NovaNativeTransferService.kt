package com.nova.downloadmanager.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import com.nova.downloadmanager.R
import com.nova.downloadmanager.app.MainActivity
import com.nova.downloadmanager.core.NovaNativeCore
import com.nova.downloadmanager.downloads.NovaTransferCore
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.roundToInt

class NovaNativeTransferService : Service() {
    private val taskIds = ConcurrentHashMap.newKeySet<Long>()

    @Volatile
    private var worker: Thread? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.getLongExtra(EXTRA_TASK_ID, -1L)
            ?.takeIf { it > 0L }
            ?.let(taskIds::add)

        startForeground(NOTIFICATION_ID, buildNotification())
        ensureWorker()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        worker?.interrupt()
        worker = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureWorker() {
        if (worker?.isAlive == true) return

        worker = Thread({
            while (!Thread.currentThread().isInterrupted) {
                val ids = taskIds.toList()
                var downloaded = 0L
                var total = 0L
                var hasTerminalTask = false

                ids.forEach { taskId ->
                    val progress = runCatching {
                        NovaNativeCore.queryHttpDownload(taskId)
                    }.getOrNull()

                    when (progress?.state) {
                        NovaNativeCore.NativeTransferState.QUEUED,
                        NovaNativeCore.NativeTransferState.DOWNLOADING,
                        -> {
                            downloaded = saturatingAdd(downloaded, progress.downloadedBytes)
                            total = saturatingAdd(total, progress.totalBytes)
                        }
                        NovaNativeCore.NativeTransferState.COMPLETED,
                        NovaNativeCore.NativeTransferState.FAILED,
                        null,
                        -> {
                            taskIds.remove(taskId)
                            hasTerminalTask = true
                        }
                    }
                }

                if (hasTerminalTask) {
                    runCatching { NovaTransferCore(applicationContext).reconcile() }
                }

                if (taskIds.isEmpty()) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                    return@Thread
                }

                getSystemService(NotificationManager::class.java)
                    .notify(NOTIFICATION_ID, buildNotification(downloaded, total))

                try {
                    Thread.sleep(POLL_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }
        }, "nova-native-transfer-service").also(Thread::start)
    }

    private fun buildNotification(
        downloadedBytes: Long = 0L,
        totalBytes: Long = 0L,
    ): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_nova_launcher)
            .setContentTitle(getString(R.string.app_name))
            .setContentIntent(pendingIntent)
            .setOnlyAlertOnce(true)
            .setOngoing(true)

        if (totalBytes > 0L) {
            val percent = ((downloadedBytes.toDouble() / totalBytes.toDouble()) * 100.0)
                .coerceIn(0.0, 100.0)
                .roundToInt()
            builder
                .setContentText("$percent%")
                .setProgress(100, percent, false)
        } else {
            builder
                .setContentText(getString(R.string.nova_navigation_downloads))
                .setProgress(0, 0, true)
        }

        return builder.build()
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.nova_navigation_downloads),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    private fun saturatingAdd(left: Long, right: Long): Long {
        if (right <= 0L) return left
        return if (left > Long.MAX_VALUE - right) Long.MAX_VALUE else left + right
    }

    companion object {
        private const val CHANNEL_ID = "nova_native_transfers"
        private const val NOTIFICATION_ID = 4201
        private const val EXTRA_TASK_ID = "native_task_id"
        private const val POLL_INTERVAL_MS = 1_000L

        fun start(context: Context, taskId: Long) {
            val intent = Intent(context, NovaNativeTransferService::class.java)
                .putExtra(EXTRA_TASK_ID, taskId)
            context.startForegroundService(intent)
        }
    }
}
