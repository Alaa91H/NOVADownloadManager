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
        viewModel.requestDownload("https://example.org/file.zip")
        assertEquals(R.string.nova_download_unavailable, viewModel.uiState.value.statusMessageRes)
    }

    @Test
    fun `direct http url is enqueued by a ready repository`() {
        val task = DownloadSummary("42", "file.zip", "queued", 0, 0)
        val viewModel = DownloadsViewModel(TestDownloadsRepository(task))

        viewModel.requestDownload("https://example.org/file.zip")

        assertEquals(listOf(task), viewModel.uiState.value.tasks)
        assertNull(viewModel.uiState.value.pendingSharedUrl)
        assertEquals(R.string.nova_download_captured, viewModel.uiState.value.statusMessageRes)
    }

    @Test
    fun `refresh removes tasks no longer returned by the transfer core`() {
        val task = DownloadSummary("42", "file.zip", "queued", 0, 0)
        val viewModel = DownloadsViewModel(TestDownloadsRepository(task))

        viewModel.requestDownload("https://example.org/file.zip")
        viewModel.refreshTasks()

        assertEquals(emptyList<DownloadSummary>(), viewModel.uiState.value.tasks)
    }

    @Test
    fun `invalid direct input never reaches the download repository`() {
        val repository = TestDownloadsRepository(DownloadSummary("42", "file.zip", "queued", 0, 0))
        val viewModel = DownloadsViewModel(repository)

        viewModel.requestDownload("file:///private/file.zip")

        assertEquals(0, repository.enqueueCount)
        assertEquals(R.string.nova_download_invalid_url, viewModel.uiState.value.statusMessageRes)
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

private class TestDownloadsRepository(
    private val result: DownloadSummary,
) : DownloadsRepository {
    var enqueueCount: Int = 0

    override fun coreReadiness(): CoreReadiness = CoreReadiness.Ready

    override fun enqueue(url: String): Result<DownloadSummary> {
        enqueueCount += 1
        return Result.success(result)
    }

    override fun refresh(taskIds: Collection<String>): List<DownloadSummary> = emptyList()
}
