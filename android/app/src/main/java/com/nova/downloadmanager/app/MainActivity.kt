package com.nova.downloadmanager.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.nova.downloadmanager.design.NOVATheme
import com.nova.downloadmanager.service.NovaTransferNotifications
import com.nova.downloadmanager.service.NovaTransferScheduler
import com.nova.downloadmanager.share.ShareIntentParser

class MainActivity : ComponentActivity() {
    private var sharedUrl by mutableStateOf<String?>(null)
    private var resumeTaskId by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        resumeTaskId = consumeResumeTaskId(intent)
        sharedUrl = ShareIntentParser.extractHttpUrl(intent)
        setContent {
            NOVATheme(
                darkTheme = androidx.compose.foundation.isSystemInDarkTheme(),
                useDynamicColor = true,
            ) {
                NOVAApp(
                    incomingSharedUrl = sharedUrl,
                    incomingResumeTaskId = resumeTaskId,
                    onResumeTaskConsumed = { resumeTaskId = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        resumeTaskId = consumeResumeTaskId(intent)
        sharedUrl = ShareIntentParser.extractHttpUrl(intent)
    }

    private fun consumeResumeTaskId(intent: Intent): String? {
        if (intent.action != NovaTransferNotifications.ACTION_RESUME) return null
        val taskId = intent.getStringExtra(NovaTransferScheduler.EXTRA_TASK_ID)
            ?.takeIf(String::isNotBlank)
        intent.action = null
        intent.removeExtra(NovaTransferScheduler.EXTRA_TASK_ID)
        return taskId
    }
}
