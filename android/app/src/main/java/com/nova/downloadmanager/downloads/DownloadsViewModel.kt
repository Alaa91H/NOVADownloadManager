package com.nova.downloadmanager.downloads

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import com.nova.downloadmanager.R
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class CoreReadiness {
    Initializing,
    BridgeNotPackaged,
    Ready,
    Unavailable,
}

data class DownloadsUiState(
    val readiness: CoreReadiness = CoreReadiness.Initializing,
    val pendingSharedUrl: String? = null,
    @param:StringRes val statusMessageRes: Int? = null,
    val tasks: List<DownloadSummary> = emptyList(),
)

data class DownloadSummary(
    val id: String,
    val name: String,
    val status: String,
    val downloadedBytes: Long,
    val totalBytes: Long,
)

class DownloadsViewModel(
    private val repository: DownloadsRepository = UnpackagedRustDownloadsRepository(),
) : ViewModel() {
    private val mutableUiState = MutableStateFlow(
        DownloadsUiState(readiness = repository.coreReadiness()),
    )
    val uiState: StateFlow<DownloadsUiState> = mutableUiState.asStateFlow()

    fun receiveSharedUrl(url: String) {
        receiveLinkForReview(url)
    }

    fun receiveBrowserDownload(url: String) {
        receiveLinkForReview(url)
    }

    fun requestDownload() {
        val message = when (mutableUiState.value.readiness) {
            CoreReadiness.Ready -> R.string.nova_download_captured
            CoreReadiness.Initializing,
            CoreReadiness.BridgeNotPackaged,
            CoreReadiness.Unavailable,
            -> R.string.nova_download_unavailable
        }
        mutableUiState.value = mutableUiState.value.copy(statusMessageRes = message)
    }

    fun clearSharedUrl() {
        mutableUiState.value = mutableUiState.value.copy(pendingSharedUrl = null)
    }

    fun acknowledgeStatusMessage() {
        mutableUiState.value = mutableUiState.value.copy(statusMessageRes = null)
    }

    private fun receiveLinkForReview(url: String) {
        mutableUiState.value = mutableUiState.value.copy(
            pendingSharedUrl = url,
            statusMessageRes = R.string.nova_download_captured,
        )
    }
}
