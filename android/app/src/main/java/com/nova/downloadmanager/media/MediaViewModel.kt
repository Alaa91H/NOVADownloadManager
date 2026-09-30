package com.nova.downloadmanager.media

import android.app.Application
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.annotation.StringRes
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.nova.downloadmanager.R
import com.nova.downloadmanager.core.NovaNativeCore
import com.nova.downloadmanager.share.SharedUrlValidator
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal data class MediaUiState(
    val sourceUrl: String = "",
    val resolving: Boolean = false,
    val descriptor: NovaNativeCore.NativeMediaDescriptor? = null,
    val selectedStreamId: String? = null,
    val sourceName: String? = null,
    val sourceRelativePath: String? = null,
    val inputContainer: String? = null,
    val capabilityRegistry: NovaNativeCore.NativeCapabilityRegistry? = null,
    val codecCapabilities: NovaNativeCore.NativeMediaCodecCapabilities? = null,
    val capabilitiesError: String? = null,
    val includeVideo: Boolean = true,
    val includeAudio: Boolean = true,
    val outputContainer: String? = null,
    val videoCodec: String? = null,
    val audioCodec: String? = null,
    val processing: Boolean = false,
    val pauseRequested: Boolean = false,
    val progress: NovaNativeCore.NativeMediaProcessingProgress? = null,
    val outputRelativePath: String? = null,
    @param:StringRes val statusMessageRes: Int? = null,
    @param:StringRes val errorMessageRes: Int? = null,
    val errorMessage: String? = null,
)

/** Android presentation adapter for native media resolution and conversion. */
internal class MediaViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application.applicationContext
    private val mutableUiState = MutableStateFlow(MediaUiState())
    val uiState: StateFlow<MediaUiState> = mutableUiState.asStateFlow()
    private var progressJob: Job? = null
    private var activeTaskId: String? = null

    init {
        viewModelScope.launch(Dispatchers.IO) {
            val result = runCatching {
                NovaNativeCore.runtimeCapabilityRegistry() to NovaNativeCore.mediaCodecCapabilities()
            }
            mutableUiState.value = result.fold(
                onSuccess = { (registry, caps) ->
                    mutableUiState.value.copy(
                        capabilityRegistry = registry,
                        codecCapabilities = caps,
                        outputContainer = chooseOutputContainers(caps, includeVideo = true, includeAudio = true)
                            .firstOrNull()
                            .takeIf { registry.supports("media.nativeMux") },
                        capabilitiesError = null,
                    ).withDefaultCodecs(caps)
                },
                onFailure = { error ->
                    mutableUiState.value.copy(capabilitiesError = error.message ?: "Native codecs are unavailable")
                },
            )
        }
    }

    fun updateSourceUrl(value: String) {
        mutableUiState.value = mutableUiState.value.copy(sourceUrl = value.take(MAX_URL_LENGTH))
    }

    fun resolveSource() {
        val url = mutableUiState.value.sourceUrl.trim()
        if (SharedUrlValidator.firstHttpUrl(url) != url) {
            mutableUiState.value = mutableUiState.value.copy(
                errorMessageRes = R.string.nova_media_invalid_url,
                errorMessage = null,
                descriptor = null,
            )
            return
        }
        viewModelScope.launch {
            mutableUiState.value = mutableUiState.value.copy(
                resolving = true,
                descriptor = null,
                selectedStreamId = null,
                errorMessageRes = null,
                errorMessage = null,
            )
            val result = withContext(Dispatchers.IO) {
                runCatching { NovaNativeCore.resolveMedia(url) }
            }
            mutableUiState.value = result.fold(
                onSuccess = { descriptor ->
                    mutableUiState.value.copy(
                        resolving = false,
                        descriptor = descriptor,
                        selectedStreamId = descriptor.streams.firstOrNull()?.id,
                        errorMessageRes = null,
                        errorMessage = null,
                    )
                },
                onFailure = { error ->
                    mutableUiState.value.copy(
                        resolving = false,
                        errorMessageRes = null,
                        errorMessage = error.message ?: "NOVA could not resolve this media page.",
                    )
                },
            )
        }
    }

    fun selectStream(id: String) {
        mutableUiState.value = mutableUiState.value.copy(selectedStreamId = id)
    }

    fun importSource(context: Context, uri: Uri) {
        viewModelScope.launch {
            mutableUiState.value = mutableUiState.value.copy(
                errorMessage = null,
                errorMessageRes = null,
                statusMessageRes = null,
            )
            val result = withContext(Dispatchers.IO) {
                runCatching { copySourceIntoPrivateStorage(context.applicationContext, uri) }
            }
            result.fold(
                onSuccess = { imported ->
                    val old = mutableUiState.value.sourceRelativePath
                    if (old != null && old != imported.relativePath) File(app.filesDir, old).delete()
                    val caps = mutableUiState.value.codecCapabilities
                    val audioOnly = imported.extension in AUDIO_ONLY_CONTAINERS
                    val includeVideo = !audioOnly
                    val includeAudio = true
                    val output = caps?.let { chooseOutputContainers(it, includeVideo, includeAudio).firstOrNull() }
                    mutableUiState.value = mutableUiState.value.copy(
                        sourceName = imported.displayName,
                        sourceRelativePath = imported.relativePath,
                        inputContainer = imported.extension,
                        includeVideo = includeVideo,
                        includeAudio = includeAudio,
                        outputContainer = output,
                        outputRelativePath = null,
                        videoCodec = null,
                        audioCodec = null,
                        statusMessageRes = R.string.nova_media_source_imported,
                        errorMessageRes = null,
                        errorMessage = null,
                    ).withDefaultCodecs(caps)
                },
                onFailure = { error ->
                    mutableUiState.value = mutableUiState.value.copy(
                        statusMessageRes = null,
                        errorMessageRes = null,
                        errorMessage = error.message ?: "NOVA could not read this media file.",
                    )
                },
            )
        }
    }

    fun setTrackIncluded(video: Boolean, included: Boolean) {
        val current = mutableUiState.value
        val includeVideo = if (video) included else current.includeVideo
        val includeAudio = if (video) current.includeAudio else included
        val caps = current.codecCapabilities ?: return
        val containers = chooseOutputContainers(caps, includeVideo, includeAudio)
        val output = current.outputContainer?.takeIf(containers::contains) ?: containers.firstOrNull()
        mutableUiState.value = current.copy(
            includeVideo = includeVideo,
            includeAudio = includeAudio,
            outputContainer = output,
            outputRelativePath = null,
            errorMessageRes = null,
            errorMessage = null,
        ).withDefaultCodecs(caps)
    }

    fun chooseContainer(extension: String) {
        val current = mutableUiState.value
        val caps = current.codecCapabilities ?: return
        if (extension !in chooseOutputContainers(caps, current.includeVideo, current.includeAudio)) return
        mutableUiState.value = current.copy(
            outputContainer = extension,
            outputRelativePath = null,
            errorMessageRes = null,
            errorMessage = null,
        ).withDefaultCodecs(caps)
    }

    fun chooseVideoCodec(codec: String) {
        val current = mutableUiState.value
        val caps = current.codecCapabilities ?: return
        if (codec !in caps.video.encodersByContainer[current.outputContainer].orEmpty()) return
        mutableUiState.value = current.copy(videoCodec = codec, outputRelativePath = null)
    }

    fun chooseAudioCodec(codec: String) {
        val current = mutableUiState.value
        val caps = current.codecCapabilities ?: return
        if (codec !in caps.audio.encodersByContainer[current.outputContainer].orEmpty()) return
        mutableUiState.value = current.copy(audioCodec = codec, outputRelativePath = null)
    }

    fun convert() {
        val current = mutableUiState.value
        val registry = current.capabilityRegistry
        if (registry == null ||
            !registry.supports("media.nativeMux") ||
            (current.includeVideo && !registry.supports("media.videoTranscode")) ||
            (current.includeAudio && !registry.supports("media.audioTranscode"))
        ) {
            mutableUiState.value = current.copy(
                errorMessage = "The selected native conversion is unavailable in this Android build.",
                errorMessageRes = null,
            )
            return
        }
        val inputPath = current.sourceRelativePath
        val inputContainer = current.inputContainer
        val outputContainer = current.outputContainer
        if (inputPath == null || inputContainer == null || outputContainer == null) {
            mutableUiState.value = current.copy(errorMessageRes = R.string.nova_media_source_empty, errorMessage = null)
            return
        }
        if ((!current.includeVideo || current.videoCodec.isNullOrBlank()) &&
            (!current.includeAudio || current.audioCodec.isNullOrBlank())
        ) {
            mutableUiState.value = current.copy(errorMessageRes = R.string.nova_media_output_track_required, errorMessage = null)
            return
        }

        val taskId = UUID.randomUUID().toString()
        val outputPath = "media-conversions/$taskId.$outputContainer"
        val options = NovaNativeCore.NativeMediaTranscodeOptions(
            inputContainer = inputContainer,
            videoCodec = current.videoCodec.takeIf { current.includeVideo },
            audioCodec = current.audioCodec.takeIf { current.includeAudio },
            includeVideo = current.includeVideo,
            includeAudio = current.includeAudio,
            qualityCrf = 23,
        )
        activeTaskId = taskId
        mutableUiState.value = current.copy(
            processing = true,
            pauseRequested = false,
            progress = null,
            outputRelativePath = null,
            statusMessageRes = null,
            errorMessageRes = null,
            errorMessage = null,
        )
        startProgressPolling(taskId)
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    NovaNativeCore.transcodeMedia(
                        taskId = taskId,
                        appPrivateRoot = app.filesDir.absolutePath,
                        sourceRelativePath = inputPath,
                        destinationRelativePath = outputPath,
                        options = options,
                    )
                }
            }
            progressJob?.cancel()
            val outcome = result.getOrNull()
            val failed = result.exceptionOrNull()
            val success = outcome?.status == "completed"
            mutableUiState.value = mutableUiState.value.copy(
                processing = false,
                pauseRequested = outcome?.status == "paused",
                progress = runCatching { NovaNativeCore.mediaProcessingProgress(taskId) }.getOrNull(),
                outputRelativePath = outputPath.takeIf { success },
                statusMessageRes = when (outcome?.status) {
                    "completed" -> R.string.nova_media_conversion_done
                    "paused" -> R.string.nova_media_paused
                    "cancelled" -> R.string.nova_media_cancelled
                    else -> null
                },
                errorMessageRes = null,
                errorMessage = failed?.message,
            )
            activeTaskId = null
            runCatching { NovaNativeCore.forgetMediaProcessingProgress(taskId) }
        }
    }

    fun pauseConversion() {
        activeTaskId?.let { taskId ->
            if (runCatching { NovaNativeCore.pauseMediaProcessing(taskId) }.getOrDefault(false)) {
                mutableUiState.value = mutableUiState.value.copy(pauseRequested = true)
            }
        }
    }

    fun resumeConversion() {
        activeTaskId?.let { taskId ->
            if (runCatching { NovaNativeCore.resumeMediaProcessing(taskId) }.getOrDefault(false)) {
                mutableUiState.value = mutableUiState.value.copy(pauseRequested = false)
            }
        }
    }

    fun cancelConversion() {
        activeTaskId?.let { taskId ->
            runCatching { NovaNativeCore.cancelMediaProcessing(taskId) }
        }
    }

    fun exportConverted(context: Context, destination: Uri) {
        val relative = mutableUiState.value.outputRelativePath ?: return
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val source = File(app.filesDir, relative)
                    check(source.isFile && source.length() > 0) { "Converted media is unavailable" }
                    context.contentResolver.openOutputStream(destination, "wt")?.use { output ->
                        val written = FileInputStream(source).use { input -> input.copyTo(output) }
                        check(written == source.length()) { "Converted media copy ended early" }
                    } ?: error("Android could not open the selected destination")
                    val sourceDigest = sha256(FileInputStream(source))
                    val outputDigest = context.contentResolver.openInputStream(destination)?.use(::sha256)
                        ?: error("Android could not verify the selected destination")
                    check(sourceDigest.contentEquals(outputDigest)) { "Saved media checksum did not match" }
                    source.delete()
                }
            }
            mutableUiState.value = mutableUiState.value.copy(
                outputRelativePath = if (result.isSuccess) null else relative,
                statusMessageRes = if (result.isSuccess) R.string.nova_media_saved else null,
                errorMessageRes = null,
                errorMessage = result.exceptionOrNull()?.message,
            )
        }
    }

    private fun startProgressPolling(taskId: String) {
        progressJob?.cancel()
        progressJob = viewModelScope.launch(Dispatchers.IO) {
            while (true) {
                val progress = runCatching { NovaNativeCore.mediaProcessingProgress(taskId) }.getOrNull()
                mutableUiState.value = mutableUiState.value.copy(progress = progress)
                if (!mutableUiState.value.processing || progress?.active == false) break
                delay(PROGRESS_REFRESH_MS)
            }
        }
    }

    private data class ImportedSource(
        val relativePath: String,
        val displayName: String,
        val extension: String,
    )

    private fun copySourceIntoPrivateStorage(context: Context, uri: Uri): ImportedSource {
        val displayName = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
            .orEmpty()
            .ifBlank { "media-input" }
            .take(MAX_FILE_NAME_LENGTH)
        val extension = displayName.substringAfterLast('.', "").lowercase()
        val capabilities = mutableUiState.value.codecCapabilities
            ?: error("NOVA native codec capabilities are unavailable")
        require(extension in capabilities.video.inputContainers || extension in capabilities.audio.inputContainers) {
            "NOVA does not include a native decoder for .$extension files"
        }
        val id = UUID.randomUUID().toString()
        val relativePath = "media-input/$id.$extension"
        val target = File(app.filesDir, relativePath)
        target.parentFile?.mkdirs()
        try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(target).use { output -> input.copyTo(output) }
            } ?: error("Android could not read the selected media file")
            require(target.isFile && target.length() > 0) { "The selected media file is empty" }
        } catch (error: Throwable) {
            target.delete()
            throw error
        }
        return ImportedSource(relativePath, displayName, extension)
    }

    private fun sha256(input: java.io.InputStream): ByteArray = input.use { stream ->
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            if (count > 0) digest.update(buffer, 0, count)
        }
        digest.digest()
    }

    private fun MediaUiState.withDefaultCodecs(
        capabilities: NovaNativeCore.NativeMediaCodecCapabilities?,
    ): MediaUiState {
        if (capabilities == null) return this
        val registry = capabilityRegistry ?: return copy(
            outputContainer = null,
            videoCodec = null,
            audioCodec = null,
        )
        if (!registry.supports("media.nativeMux") ||
            (includeVideo && !registry.supports("media.videoTranscode")) ||
            (includeAudio && !registry.supports("media.audioTranscode"))
        ) {
            return copy(outputContainer = null, videoCodec = null, audioCodec = null)
        }
        val output = outputContainer?.takeIf {
            it in chooseOutputContainers(capabilities, includeVideo, includeAudio)
        } ?: chooseOutputContainers(capabilities, includeVideo, includeAudio).firstOrNull()
        return copy(
            outputContainer = output,
            videoCodec = if (includeVideo) {
                val supported = output?.let { capabilities.video.encodersByContainer[it] }.orEmpty()
                videoCodec?.takeIf(supported::contains) ?: supported.firstOrNull()
            } else null,
            audioCodec = if (includeAudio) {
                val supported = output?.let { capabilities.audio.encodersByContainer[it] }.orEmpty()
                audioCodec?.takeIf(supported::contains) ?: supported.firstOrNull()
            } else null,
        )
    }

    private fun chooseOutputContainers(
        capabilities: NovaNativeCore.NativeMediaCodecCapabilities,
        includeVideo: Boolean,
        includeAudio: Boolean,
    ): List<String> {
        val supported = when {
            includeVideo && includeAudio -> capabilities.video.encodersByContainer.keys
                .intersect(capabilities.audio.encodersByContainer.keys)
            includeVideo -> capabilities.video.encodersByContainer.keys
            includeAudio -> capabilities.audio.encodersByContainer.keys
            else -> emptySet()
        }
        return supported.sortedWith(compareBy<String> { OUTPUT_CONTAINER_ORDER.indexOf(it).let { index -> if (index < 0) Int.MAX_VALUE else index } }.thenBy { it })
    }

    private companion object {
        const val MAX_URL_LENGTH = 8_192
        const val MAX_FILE_NAME_LENGTH = 240
        const val PROGRESS_REFRESH_MS = 400L
        val AUDIO_ONLY_CONTAINERS = setOf("m4a", "mka", "mp3", "flac", "ogg", "oga", "opus", "wav", "wave")
        val OUTPUT_CONTAINER_ORDER = listOf("mp4", "mkv", "webm", "m4a", "mp3", "flac", "ogg", "opus", "wav")
    }
}
