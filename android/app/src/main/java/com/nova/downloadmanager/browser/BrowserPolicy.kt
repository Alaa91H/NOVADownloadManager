package com.nova.downloadmanager.browser

import java.net.IDN
import java.net.URI
import java.util.Locale

/**
 * Safety and compatibility policy for the in-app browser.
 *
 * NOVA only renders ordinary HTTP(S) content. It never opens local files,
 * intent URLs, JavaScript URLs, or arbitrary schemes from a remote page. The
 * user may still explicitly share an HTTP(S) link to the download review path.
 */
object BrowserUrlPolicy {
    private val blockedHostSuffixes = setOf(
        "doubleclick.net",
        "doubleclick.com",
        "googlesyndication.com",
        "googleadservices.com",
        "adnxs.com",
        "adsrvr.org",
        "scorecardresearch.com",
        "taboola.com",
        "outbrain.com",
    )

    fun normalizeTypedAddress(value: String): String? {
        val trimmed = value.trim()
        if (trimmed.isEmpty() || trimmed.length > MAX_URL_LENGTH) return null
        val candidate = if ("://" in trimmed) trimmed else "https://$trimmed"
        return normalizeHttpUrl(candidate)
    }

    fun normalizeHttpUrl(value: String): String? {
        val candidate = value.trim()
        if (candidate.isEmpty() || candidate.length > MAX_URL_LENGTH) return null

        return runCatching {
            val uri = URI(candidate)
            val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
            if (scheme != "https" && scheme != "http") return null
            if (uri.userInfo != null || uri.host.isNullOrBlank()) return null
            if (uri.fragment?.length ?: 0 > MAX_FRAGMENT_LENGTH) return null

            val host = canonicalHost(uri.host) ?: return null
            URI(
                scheme,
                null,
                host,
                uri.port,
                uri.rawPath ?: "",
                uri.rawQuery,
                null,
            ).toASCIIString()
        }.getOrNull()
    }

    fun isBlockedRequest(url: String): Boolean {
        val host = runCatching { URI(url).host }.getOrNull()?.let(::canonicalHost) ?: return false
        return blockedHostSuffixes.any { suffix -> host == suffix || host.endsWith(".$suffix") }
    }

    fun isSafeTopLevelUrl(url: String): Boolean = normalizeHttpUrl(url) != null

    fun canonicalHost(value: String): String? = runCatching {
        IDN.toASCII(value.trim().trimEnd('.'), IDN.USE_STD3_ASCII_RULES)
            .lowercase(Locale.ROOT)
            .takeIf { it.isNotBlank() && it.length <= MAX_HOST_LENGTH }
    }.getOrNull()

    private const val MAX_URL_LENGTH = 8_192
    private const val MAX_FRAGMENT_LENGTH = 1_024
    private const val MAX_HOST_LENGTH = 253
}

/**
 * A locally stored snippet that is injected only in a matching top-level HTTPS
 * page after the user has explicitly enabled it. No native JavaScript bridge is
 * exposed, so scripts cannot access NOVA downloads, Android APIs, cookies, or
 * other browser tabs through privileged calls.
 */
data class UserScript(
    val id: String,
    val name: String,
    val allowedHost: String,
    val source: String,
    val enabled: Boolean = true,
)

object UserScriptPolicy {
    const val MAX_SCRIPT_BYTES = 64 * 1024
    const val MAX_SCRIPT_NAME_LENGTH = 80

    fun validate(name: String, allowedHost: String, source: String): UserScriptValidation {
        val normalizedName = name.trim()
        val normalizedHost = BrowserUrlPolicy.canonicalHost(allowedHost)
        if (normalizedName.isEmpty() || normalizedName.length > MAX_SCRIPT_NAME_LENGTH) {
            return UserScriptValidation.InvalidName
        }
        if (normalizedHost == null || normalizedHost == "localhost" || normalizedHost.matches(Regex("^\\d{1,3}(?:\\.\\d{1,3}){3}$"))) {
            return UserScriptValidation.InvalidHost
        }
        if (source.isBlank() || source.toByteArray(Charsets.UTF_8).size > MAX_SCRIPT_BYTES) {
            return UserScriptValidation.InvalidSource
        }
        return UserScriptValidation.Valid
    }

    fun matches(script: UserScript, topLevelUrl: String): Boolean {
        val uri = runCatching { URI(topLevelUrl) }.getOrNull() ?: return false
        val host = uri.host?.let(BrowserUrlPolicy::canonicalHost) ?: return false
        return uri.scheme.equals("https", ignoreCase = true) &&
            (host == script.allowedHost || host.endsWith(".${script.allowedHost}"))
    }

    fun wrappedSource(script: UserScript): String {
        // IIFE limits accidental globals. This is isolation, not a security
        // sandbox: user scripts remain untrusted page-side JavaScript.
        return "(function () { 'use strict';\n${script.source}\n})();"
    }
}

sealed interface UserScriptValidation {
    data object Valid : UserScriptValidation
    data object InvalidName : UserScriptValidation
    data object InvalidHost : UserScriptValidation
    data object InvalidSource : UserScriptValidation
}
