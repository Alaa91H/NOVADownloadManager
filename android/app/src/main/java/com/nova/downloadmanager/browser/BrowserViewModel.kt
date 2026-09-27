package com.nova.downloadmanager.browser

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

private const val MAX_USER_SCRIPTS = 8
private const val MAX_DNS_ENDPOINT_LENGTH = 512

enum class DnsPrivacyProfile(val endpoint: String?) {
    System(null),
    Cloudflare("https://cloudflare-dns.com/dns-query"),
    Google("https://dns.google/dns-query"),
    Quad9("https://dns.quad9.net/dns-query"),
    AdGuard("https://dns.adguard-dns.com/dns-query"),
    Custom(null),
}

data class BrowserUiState(
    val cleanBrowsingEnabled: Boolean = true,
    val captureEnabled: Boolean = true,
    val userScriptsEnabled: Boolean = false,
    val scripts: List<UserScript> = emptyList(),
    val dnsProfile: DnsPrivacyProfile = DnsPrivacyProfile.System,
    val customDnsEndpoint: String = "",
)

/**
 * Persists user-controlled browser preferences only. The selected DoH endpoint
 * is a validated preference for a later consent-based private-routing service;
 * it never changes Android's system DNS and is not applied to WebView traffic.
 */
class BrowserViewModel(application: Application) : AndroidViewModel(application) {
    private val store = BrowserPreferences(application)
    private val mutableUiState = MutableStateFlow(store.load())
    val uiState: StateFlow<BrowserUiState> = mutableUiState.asStateFlow()

    fun setCleanBrowsingEnabled(enabled: Boolean) = update { it.copy(cleanBrowsingEnabled = enabled) }

    fun setCaptureEnabled(enabled: Boolean) = update { it.copy(captureEnabled = enabled) }

    fun setUserScriptsEnabled(enabled: Boolean) = update { it.copy(userScriptsEnabled = enabled) }

    fun setDnsProfile(profile: DnsPrivacyProfile) = update {
        it.copy(dnsProfile = profile)
    }

    fun setCustomDnsEndpoint(endpoint: String) = update {
        it.copy(customDnsEndpoint = endpoint.take(MAX_DNS_ENDPOINT_LENGTH))
    }

    fun hasValidCustomDnsEndpoint(): Boolean = DnsEndpointPolicy.isValid(uiState.value.customDnsEndpoint)

    fun addUserScript(name: String, allowedHost: String, source: String): Boolean {
        if (uiState.value.scripts.size >= MAX_USER_SCRIPTS) return false
        if (UserScriptPolicy.validate(name, allowedHost, source) != UserScriptValidation.Valid) return false
        val script = UserScript(
            id = UUID.randomUUID().toString(),
            name = name.trim(),
            allowedHost = BrowserUrlPolicy.canonicalHost(allowedHost)!!,
            source = source.trim(),
        )
        update { it.copy(scripts = it.scripts + script) }
        return true
    }

    fun removeUserScript(id: String) = update { state ->
        state.copy(scripts = state.scripts.filterNot { it.id == id })
    }

    private fun update(transform: (BrowserUiState) -> BrowserUiState) {
        val next = transform(mutableUiState.value)
        mutableUiState.value = next
        store.save(next)
    }

}

object DnsEndpointPolicy {
    fun isValid(value: String): Boolean {
        val normalized = BrowserUrlPolicy.normalizeHttpUrl(value) ?: return false
        return normalized.startsWith("https://") &&
            normalized.substringAfter("https://").contains("/dns-query") &&
            !normalized.contains('@')
    }
}

private class BrowserPreferences(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun load(): BrowserUiState {
        val profile = runCatching {
            DnsPrivacyProfile.valueOf(preferences.getString(KEY_DNS_PROFILE, DnsPrivacyProfile.System.name)!!)
        }.getOrDefault(DnsPrivacyProfile.System)
        return BrowserUiState(
            cleanBrowsingEnabled = preferences.getBoolean(KEY_CLEAN_BROWSING, true),
            captureEnabled = preferences.getBoolean(KEY_CAPTURE, true),
            userScriptsEnabled = preferences.getBoolean(KEY_USER_SCRIPTS, false),
            scripts = readScripts(),
            dnsProfile = profile,
            customDnsEndpoint = preferences.getString(KEY_CUSTOM_DNS, "").orEmpty(),
        )
    }

    fun save(state: BrowserUiState) {
        preferences.edit()
            .putBoolean(KEY_CLEAN_BROWSING, state.cleanBrowsingEnabled)
            .putBoolean(KEY_CAPTURE, state.captureEnabled)
            .putBoolean(KEY_USER_SCRIPTS, state.userScriptsEnabled)
            .putString(KEY_DNS_PROFILE, state.dnsProfile.name)
            .putString(KEY_CUSTOM_DNS, state.customDnsEndpoint)
            .putString(KEY_SCRIPTS, writeScripts(state.scripts))
            .apply()
    }

    private fun readScripts(): List<UserScript> = runCatching {
        val array = JSONArray(preferences.getString(KEY_SCRIPTS, "[]"))
        buildList {
            for (index in 0 until minOf(array.length(), MAX_USER_SCRIPTS)) {
                val raw = array.optJSONObject(index) ?: continue
                val script = UserScript(
                    id = raw.optString("id"),
                    name = raw.optString("name"),
                    allowedHost = raw.optString("allowedHost"),
                    source = raw.optString("source"),
                    enabled = raw.optBoolean("enabled", true),
                )
                if (script.id.isNotBlank() &&
                    UserScriptPolicy.validate(script.name, script.allowedHost, script.source) == UserScriptValidation.Valid
                ) {
                    add(script.copy(allowedHost = BrowserUrlPolicy.canonicalHost(script.allowedHost)!!))
                }
            }
        }
    }.getOrDefault(emptyList())

    private fun writeScripts(scripts: List<UserScript>): String = JSONArray().apply {
        scripts.take(MAX_USER_SCRIPTS).forEach { script ->
            put(
                JSONObject()
                    .put("id", script.id)
                    .put("name", script.name)
                    .put("allowedHost", script.allowedHost)
                    .put("source", script.source)
                    .put("enabled", script.enabled),
            )
        }
    }.toString()

    private companion object {
        const val PREFERENCES_NAME = "nova_browser_preferences"
        const val KEY_CLEAN_BROWSING = "clean_browsing"
        const val KEY_CAPTURE = "capture"
        const val KEY_USER_SCRIPTS = "user_scripts_enabled"
        const val KEY_DNS_PROFILE = "dns_profile"
        const val KEY_CUSTOM_DNS = "custom_dns_endpoint"
        const val KEY_SCRIPTS = "user_scripts"
    }
}
