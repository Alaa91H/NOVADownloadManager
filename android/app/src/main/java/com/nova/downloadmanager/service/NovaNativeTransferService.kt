package com.nova.downloadmanager.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.nova.downloadmanager.R
import com.nova.downloadmanager.downloads.NovaTransferCore
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Keeps the Android process in a valid foreground data-sync lifecycle while
 * NOVA's Rust worker threads own the actual network transfer.
 */
class NovaNativeTransferService : Service() {
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val pollingStarted = AtomicBoolean(false)

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification(indeterminate = true, percent = 0))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (pollingStarted.compareAndSet(false, true)) {
            executor.scheduleWithFixedDelay(
                ::reconcileNativeTasks,
                0,
                RECONCILE_INTERVAL_SECONDS,
                TimeUnit.SECONDS,
            )
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun reconcileNativeTasks() {
        val tasks = runCatching {
            NovaTransferCore(applicationContext).reconcile()
        }.getOrElse {
            stopSelf()
            return
        }

        val active = tasks.filter { it.status == STATUS_QUEUED || it.status == STATUS_DOWNLOADING }
        if (active.isEmpty()) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }

        val total = active.sumOf { it.totalBytes.coerceAtLeast(0) }
        val downloaded = active.sumOf { it.downloadedBytes.coerceAtLeast(0) }
        val determinate = total > 0 && active.all { it.totalBytes > 0 }
        val percent = if (determinate) {
            ((downloaded.coerceAtMost(total) * 100L) / total).toInt().coerceIn(0, 100)
        } else {
            0
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(
            NOTIFICATION_ID,
            buildNotification(indeterminate = !determinate, percent = percent),
        )
    }

    private fun buildNotification(indeterminate: Boolean, percent: Int) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_nova_launcher)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.nova_filter_active))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(100, percent, indeterminate)
            .build()

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.app_name),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    private companion object {
        const val CHANNEL_ID = "nova-native-transfers"
        const val NOTIFICATION_ID = 24043
        const val RECONCILE_INTERVAL_SECONDS = 1L
        const val STATUS_QUEUED = "queued"
        const val STATUS_DOWNLOADING = "downloading"
    }
}
