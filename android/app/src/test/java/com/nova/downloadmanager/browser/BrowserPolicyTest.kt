package com.nova.downloadmanager.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserPolicyTest {
    @Test
    fun `typed bare host becomes safe HTTPS address`() {
        assertEquals(
            "https://downloads.example.org/releases/app.apk",
            BrowserUrlPolicy.normalizeTypedAddress("downloads.example.org/releases/app.apk"),
        )
    }

    @Test
    fun `rejects non web schemes credentials and malformed addresses`() {
        assertNull(BrowserUrlPolicy.normalizeHttpUrl("javascript:alert(1)"))
        assertNull(BrowserUrlPolicy.normalizeHttpUrl("file:///sdcard/private.txt"))
        assertNull(BrowserUrlPolicy.normalizeHttpUrl("intent://example.org"))
        assertNull(BrowserUrlPolicy.normalizeHttpUrl("https://user:secret@example.org/file"))
        assertNull(BrowserUrlPolicy.normalizeTypedAddress("https://"))
    }

    @Test
    fun `blocks exact and subdomain advertising hosts without blocking unrelated hosts`() {
        assertTrue(BrowserUrlPolicy.isBlockedRequest("https://doubleclick.net/pagead"))
        assertTrue(BrowserUrlPolicy.isBlockedRequest("https://securepubads.g.doubleclick.net/tag"))
        assertFalse(BrowserUrlPolicy.isBlockedRequest("https://notdoubleclick.net/content"))
        assertFalse(BrowserUrlPolicy.isBlockedRequest("https://cdn.example.org/file.zip"))
    }

    @Test
    fun `user scripts require constrained fields and matching HTTPS top page`() {
        assertEquals(
            UserScriptValidation.Valid,
            UserScriptPolicy.validate("Reader cleanup", "example.org", "document.body.dataset.nova = '1';"),
        )
        assertEquals(
            UserScriptValidation.InvalidHost,
            UserScriptPolicy.validate("Reader cleanup", "http://example.org", "alert(1)"),
        )
        assertEquals(
            UserScriptValidation.InvalidSource,
            UserScriptPolicy.validate("Reader cleanup", "example.org", ""),
        )

        val script = UserScript("one", "Reader cleanup", "example.org", "document.title = 'Clean';")
        assertTrue(UserScriptPolicy.matches(script, "https://reader.example.org/article"))
        assertFalse(UserScriptPolicy.matches(script, "http://reader.example.org/article"))
        assertFalse(UserScriptPolicy.matches(script, "https://example.org.attacker.test/article"))
        assertTrue(UserScriptPolicy.wrappedSource(script).startsWith("(function ()"))
    }

    @Test
    fun `DNS privacy endpoint requires HTTPS and standard DoH path`() {
        assertTrue(DnsEndpointPolicy.isValid("https://dns.quad9.net/dns-query"))
        assertTrue(DnsEndpointPolicy.isValid("https://cloudflare-dns.com/dns-query"))
        assertFalse(DnsEndpointPolicy.isValid("http://dns.example.org/dns-query"))
        assertFalse(DnsEndpointPolicy.isValid("https://user:secret@dns.example.org/dns-query"))
        assertFalse(DnsEndpointPolicy.isValid("https://dns.example.org/resolve"))
    }
}
