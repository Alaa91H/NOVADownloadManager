package com.nova.downloadmanager.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class DownloadDestinationStoreTest {
    @Test
    fun `safeName removes path separators and control characters`() {
        assertEquals("movie__final.mp4", DownloadDestinationStore.safeName("../movie/\u0001final.mp4"))
    }

    @Test
    fun `safeName rejects empty and dot-only names`() {
        assertEquals("download", DownloadDestinationStore.safeName("..."))
        assertEquals("download", DownloadDestinationStore.safeName("   "))
    }

    @Test
    fun `safeName caps untrusted names at the filesystem display limit`() {
        val name = DownloadDestinationStore.safeName("a".repeat(200))
        assertEquals(120, name.length)
        assertNotEquals("a".repeat(200), name)
    }
}
