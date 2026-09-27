package com.nova.downloadmanager.share

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SharedUrlValidatorTest {
    @Test
    fun `extracts the first supported URL from shared text`() {
        assertEquals(
            "https://downloads.example.org/file.zip?part=1",
            SharedUrlValidator.firstHttpUrl(
                "A useful link: https://downloads.example.org/file.zip?part=1 and a note",
            ),
        )
    }

    @Test
    fun `rejects non web URLs and malformed values`() {
        assertNull(SharedUrlValidator.firstHttpUrl("file:///storage/emulated/0/download.zip"))
        assertNull(SharedUrlValidator.firstHttpUrl("https://"))
        assertNull(SharedUrlValidator.firstHttpUrl("not-a-url"))
    }
}
