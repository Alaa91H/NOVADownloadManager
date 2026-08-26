package com.nova.downloadmanager.downloads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DownloadsViewModelTest {
    @Test
    fun `receiving a shared URL exposes it for UI review`() {
        val viewModel = DownloadsViewModel()

        viewModel.receiveSharedUrl("https://example.org/release.apk")

        assertEquals(
            "https://example.org/release.apk",
            viewModel.uiState.value.pendingSharedUrl,
        )
        assertEquals(
            "Link ready for NOVA download review",
            viewModel.uiState.value.statusMessage,
        )
    }

    @Test
    fun `dismissing a shared URL preserves the empty task collection`() {
        val viewModel = DownloadsViewModel()
        viewModel.receiveSharedUrl("https://example.org/file")

        viewModel.clearSharedUrl()

        assertNull(viewModel.uiState.value.pendingSharedUrl)
        assertEquals(emptyList<DownloadSummary>(), viewModel.uiState.value.tasks)
    }
}
