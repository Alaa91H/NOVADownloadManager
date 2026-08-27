package com.nova.downloadmanager.downloads

import com.nova.downloadmanager.R
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
            R.string.nova_download_captured,
            viewModel.uiState.value.statusMessageRes,
        )
    }

    @Test
    fun `browser capture uses the same reviewed intake path`() {
        val viewModel = DownloadsViewModel()
        viewModel.receiveBrowserDownload("https://cdn.example.org/video.mp4")
        assertEquals("https://cdn.example.org/video.mp4", viewModel.uiState.value.pendingSharedUrl)
        assertEquals(R.string.nova_download_captured, viewModel.uiState.value.statusMessageRes)
    }

    @Test
    fun `requesting a download stays truthful while native core is unavailable`() {
        val viewModel = DownloadsViewModel()
        viewModel.requestDownload()
        assertEquals(R.string.nova_download_unavailable, viewModel.uiState.value.statusMessageRes)
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
