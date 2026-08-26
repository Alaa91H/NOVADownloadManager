package com.nova.downloadmanager.downloads

import androidx.lifecycle.ViewModel
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
    val statusMessage: String? = null,
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
        mutableUiState.value = mutableUiState.value.copy(
            pendingSharedUrl = url,
            statusMessage = "Link ready for NOVA download review",
        )
    }

    fun clearSharedUrl() {
        mutableUiState.value = mutableUiState.value.copy(pendingSharedUrl = null)
    }

    fun acknowledgeStatusMessage() {
        mutableUiState.value = mutableUiState.value.copy(statusMessage = null)
    }
}
