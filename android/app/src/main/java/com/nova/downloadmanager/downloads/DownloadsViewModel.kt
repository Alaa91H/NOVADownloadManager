package com.nova.downloadmanager.downloads

import android.content.Context
import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import com.nova.downloadmanager.R
import com.nova.downloadmanager.share.SharedUrlValidator
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
    private var repository: DownloadsRepository = UnpackagedRustDownloadsRepository(),
) : ViewModel() {
    private val mutableUiState = MutableStateFlow(
        DownloadsUiState(readiness = repository.coreReadiness()),
    )
    val uiState: StateFlow<DownloadsUiState> = mutableUiState.asStateFlow()

    /** Attach the Android-owned direct-download engine once a valid app Context exists. */
    fun attachPlatformRepository(context: Context) {
        if (repository is PlatformDownloadsRepository) return
        repository = try {
            PlatformDownloadsRepository(context)
        } catch (_: RuntimeException) {
            UnpackagedRustDownloadsRepository()
        }
        mutableUiState.value = mutableUiState.value.copy(readiness = repository.coreReadiness())
    }

    fun receiveSharedUrl(url: String) {
        receiveLinkForReview(url)
    }

    fun receiveBrowserDownload(url: String) {
        receiveLinkForReview(url)
    }

    fun requestDownload(url: String? = mutableUiState.value.pendingSharedUrl) {
        val normalizedUrl = url?.trim().orEmpty()
        if (SharedUrlValidator.firstHttpUrl(normalizedUrl) != normalizedUrl) {
            mutableUiState.value = mutableUiState.value.copy(statusMessageRes = R.string.nova_download_invalid_url)
            return
        }
        if (mutableUiState.value.readiness != CoreReadiness.Ready) {
            mutableUiState.value = mutableUiState.value.copy(statusMessageRes = R.string.nova_download_unavailable)
            return
        }

        repository.enqueue(normalizedUrl)
            .onSuccess { summary ->
                mutableUiState.value = mutableUiState.value.copy(
                    pendingSharedUrl = null,
                    statusMessageRes = R.string.nova_download_captured,
                    tasks = listOf(summary) + mutableUiState.value.tasks.filterNot { it.id == summary.id },
                )
            }
            .onFailure {
                mutableUiState.value = mutableUiState.value.copy(statusMessageRes = R.string.nova_download_unavailable)
            }
    }

    fun refreshTasks() {
        val ids = mutableUiState.value.tasks.map(DownloadSummary::id)
        if (ids.isEmpty() || mutableUiState.value.readiness != CoreReadiness.Ready) return
        val refreshed = repository.refresh(ids)
        if (refreshed.isNotEmpty()) {
            mutableUiState.value = mutableUiState.value.copy(tasks = refreshed)
        }
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
