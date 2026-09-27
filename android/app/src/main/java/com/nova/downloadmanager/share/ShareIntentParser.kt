package com.nova.downloadmanager.share

import android.content.Intent
import java.net.URI

object ShareIntentParser {
    fun extractHttpUrl(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_SEND || intent.type != "text/plain") {
            return null
        }
        return SharedUrlValidator.firstHttpUrl(intent.getStringExtra(Intent.EXTRA_TEXT))
    }
}

object SharedUrlValidator {
    fun firstHttpUrl(sharedText: String?): String? = sharedText
        ?.trim()
        ?.split(Regex("\\s+"))
        ?.firstOrNull(::isSupportedHttpUrl)

    private fun isSupportedHttpUrl(candidate: String): Boolean {
        val uri = runCatching { URI(candidate) }.getOrNull() ?: return false
        return uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank()
    }
}
