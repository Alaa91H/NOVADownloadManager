package com.nova.downloadmanager.media

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nova.downloadmanager.R
import com.nova.downloadmanager.core.NovaNativeCore
import com.nova.downloadmanager.design.NOVADimens

@Composable
internal fun MediaSelectionScreen(
    onRequestMediaDownload: (String, String, String, String?) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: MediaViewModel = viewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    var pendingOutputName by remember { mutableStateOf("nova-converted-media") }
    val sourcePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        uri?.let { viewModel.importSource(context, it) }
    }
    val outputPicker = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri: Uri? ->
        uri?.let { viewModel.exportConverted(context, it) }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = NOVADimens.ScreenHorizontal, vertical = NOVADimens.Section),
        verticalArrangement = Arrangement.spacedBy(NOVADimens.ItemGap),
    ) {
        Text(stringResource(R.string.nova_media_title), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.nova_media_detail), style = MaterialTheme.typography.bodyLarge)

        MediaResolverCard(
            state = state,
            onUrlChanged = viewModel::updateSourceUrl,
            onResolve = viewModel::resolveSource,
            onSelectStream = viewModel::selectStream,
            onRequestMediaDownload = onRequestMediaDownload,
        )

        MediaCodecCard(
            state = state,
            onChooseSource = {
                sourcePicker.launch(arrayOf("video/*", "audio/*", "application/octet-stream"))
            },
            onToggleVideo = { viewModel.setTrackIncluded(video = true, included = it) },
            onToggleAudio = { viewModel.setTrackIncluded(video = false, included = it) },
            onChooseContainer = viewModel::chooseContainer,
            onChooseVideoCodec = viewModel::chooseVideoCodec,
            onChooseAudioCodec = viewModel::chooseAudioCodec,
            onConvert = viewModel::convert,
            onPause = viewModel::pauseConversion,
            onResume = viewModel::resumeConversion,
            onCancel = viewModel::cancelConversion,
            onSave = {
                val extension = state.outputContainer.orEmpty()
                val stem = state.sourceName.orEmpty().substringBeforeLast('.', "converted-media")
                    .ifBlank { "converted-media" }
                pendingOutputName = "$stem.$extension"
                outputPicker.launch(pendingOutputName)
            },
        )

        state.statusMessageRes?.let { message ->
            Text(stringResource(message), color = MaterialTheme.colorScheme.primary)
        }
        state.errorMessageRes?.let { message ->
            Text(stringResource(message), color = MaterialTheme.colorScheme.error)
        }
        state.errorMessage?.let { message ->
            Text(message, color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun MediaResolverCard(
    state: MediaUiState,
    onUrlChanged: (String) -> Unit,
    onResolve: () -> Unit,
    onSelectStream: (String) -> Unit,
    onRequestMediaDownload: (String, String, String, String?) -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(NOVADimens.CompactGap),
        ) {
            Text(stringResource(R.string.nova_media_resolve_title), style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(
                value = state.sourceUrl,
                onValueChange = onUrlChanged,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.nova_media_source_url)) },
                singleLine = true,
            )
            Button(onClick = onResolve, enabled = state.sourceUrl.isNotBlank() && !state.resolving) {
                Text(stringResource(if (state.resolving) R.string.nova_media_resolving else R.string.nova_media_analyze))
            }
            if (state.resolving) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())

            state.descriptor?.let { descriptor ->
                HorizontalDivider()
                Text(descriptor.title, style = MaterialTheme.typography.titleMedium)
                Text(
                    text = listOfNotNull(descriptor.sourceKind, descriptor.uploader, descriptor.durationMillis?.let(::formatDuration))
                        .joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(stringResource(R.string.nova_media_streams), style = MaterialTheme.typography.titleSmall)
                if (descriptor.streams.isEmpty()) {
                    Text(stringResource(R.string.nova_media_no_streams), style = MaterialTheme.typography.bodyMedium)
                }
                descriptor.streams.take(MAX_VISIBLE_STREAMS).forEach { stream ->
                    val selected = stream.id == state.selectedStreamId
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onSelectStream(stream.id) },
                        colors = CardDefaults.cardColors(
                            containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer
                            else MaterialTheme.colorScheme.surface,
                        ),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = selected, onClick = { onSelectStream(stream.id) })
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(
                                    text = "${stream.kind} · ${stream.protocol.uppercase()} · ${stream.container ?: "?"}",
                                    style = MaterialTheme.typography.titleSmall,
                                )
                                Text(
                                    text = listOfNotNull(
                                        stream.width?.let { width -> stream.height?.let { height -> "${width}×$height" } },
                                        stream.videoCodec,
                                        stream.audioCodec,
                                        stream.bitrateBps?.let(::formatBitrate),
                                    ).joinToString(" · ").ifBlank { stream.id },
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        }
                    }
                }
                val selectedStream = descriptor.streams.firstOrNull { it.id == state.selectedStreamId }
                when {
                    selectedStream != null && selectedStream.protocol in DOWNLOADABLE_PROTOCOLS -> {
                        Button(onClick = {
                            onRequestMediaDownload(
                                descriptor.webpageUrl,
                                selectedStream.id,
                                descriptor.title,
                                selectedStream.container ?: when (selectedStream.protocol) {
                                    "hls" -> "ts"
                                    "dash" -> "mp4"
                                    else -> null
                                },
                            )
                        }) {
                            Text(stringResource(R.string.nova_media_download_stream))
                        }
                    }
                    selectedStream != null -> {
                        Text(
                            stringResource(R.string.nova_media_direct_only),
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MediaCodecCard(
    state: MediaUiState,
    onChooseSource: () -> Unit,
    onToggleVideo: (Boolean) -> Unit,
    onToggleAudio: (Boolean) -> Unit,
    onChooseContainer: (String) -> Unit,
    onChooseVideoCodec: (String) -> Unit,
    onChooseAudioCodec: (String) -> Unit,
    onConvert: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onCancel: () -> Unit,
    onSave: () -> Unit,
) {
    val capabilities = state.codecCapabilities
    val outputContainers = capabilities?.let {
        supportedOutputContainers(it, state.includeVideo, state.includeAudio)
    }.orEmpty()
    val videoEncoders = capabilities?.video?.encodersByContainer?.get(state.outputContainer).orEmpty()
    val audioEncoders = capabilities?.audio?.encodersByContainer?.get(state.outputContainer).orEmpty()

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(NOVADimens.CompactGap),
        ) {
            Text(stringResource(R.string.nova_media_codec_title), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.nova_media_codec_detail), style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.nova_media_supported_formats), style = MaterialTheme.typography.bodySmall)

            Button(onClick = onChooseSource, enabled = !state.processing && capabilities != null) {
                Text(stringResource(R.string.nova_media_choose_file))
            }
            if (state.sourceName == null) {
                Text(stringResource(R.string.nova_media_source_empty), style = MaterialTheme.typography.bodyMedium)
            } else {
                Text(
                    text = "${state.sourceName} · .${state.inputContainer.orEmpty()}",
                    style = MaterialTheme.typography.titleSmall,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = state.includeVideo,
                        onClick = { onToggleVideo(!state.includeVideo) },
                        label = { Text(stringResource(R.string.nova_media_include_video)) },
                        enabled = !state.processing,
                    )
                    FilterChip(
                        selected = state.includeAudio,
                        onClick = { onToggleAudio(!state.includeAudio) },
                        label = { Text(stringResource(R.string.nova_media_include_audio)) },
                        enabled = !state.processing,
                    )
                }
                Text(stringResource(R.string.nova_media_output_container), style = MaterialTheme.typography.labelLarge)
                ChoiceChips(
                    values = outputContainers,
                    selected = state.outputContainer,
                    enabled = !state.processing,
                    onSelect = onChooseContainer,
                )
                if (state.includeVideo) {
                    Text(stringResource(R.string.nova_media_video_codec), style = MaterialTheme.typography.labelLarge)
                    ChoiceChips(videoEncoders, state.videoCodec, !state.processing, onChooseVideoCodec)
                }
                if (state.includeAudio) {
                    Text(stringResource(R.string.nova_media_audio_codec), style = MaterialTheme.typography.labelLarge)
                    ChoiceChips(audioEncoders, state.audioCodec, !state.processing, onChooseAudioCodec)
                }
            }

            if (capabilities == null) {
                Text(stringResource(R.string.nova_media_codec_unavailable), color = MaterialTheme.colorScheme.error)
            }
            if (state.processing) {
                val fraction = state.progress?.fraction?.toFloat()
                if (fraction != null) {
                    LinearProgressIndicator(progress = { fraction.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                } else {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
                state.progress?.let { progress ->
                    Text(
                        text = "${stringResource(processingPhaseResource(progress.phase))} · ${stringResource(R.string.nova_media_frames_count, progress.completedUnits)}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (state.pauseRequested) {
                        Button(onClick = onResume) { Text(stringResource(R.string.nova_media_resume_conversion)) }
                    } else {
                        Button(onClick = onPause) { Text(stringResource(R.string.nova_status_paused)) }
                    }
                    Button(onClick = onCancel) { Text(stringResource(R.string.nova_action_cancel)) }
                }
            } else if (state.outputRelativePath == null) {
                Button(
                    onClick = onConvert,
                    enabled = capabilities != null && state.sourceRelativePath != null && outputContainers.isNotEmpty(),
                ) {
                    Text(stringResource(R.string.nova_media_start_conversion))
                }
            } else {
                AssistChip(
                    onClick = onSave,
                    label = { Text(stringResource(R.string.nova_media_save_converted)) },
                )
            }
            state.capabilitiesError?.let { detail ->
                Text(stringResource(R.string.nova_media_codec_unavailable), color = MaterialTheme.colorScheme.error)
                Text(detail, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun ChoiceChips(
    values: List<String>,
    selected: String?,
    enabled: Boolean,
    onSelect: (String) -> Unit,
) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        values.forEach { value ->
            FilterChip(
                selected = selected == value,
                onClick = { onSelect(value) },
                label = { Text(value, fontFamily = FontFamily.Monospace) },
                enabled = enabled,
            )
        }
    }
}

private fun supportedOutputContainers(
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
    val preferred = listOf("mp4", "mkv", "webm", "m4a", "mp3", "flac", "ogg", "opus", "wav")
    return supported.sortedWith(compareBy<String> { preferred.indexOf(it).let { index -> if (index < 0) Int.MAX_VALUE else index } }.thenBy { it })
}

private fun processingPhaseResource(phase: Int): Int = when (phase) {
    0 -> R.string.nova_media_phase_planning
    1 -> R.string.nova_media_phase_probing
    2 -> R.string.nova_media_phase_demuxing
    3 -> R.string.nova_media_phase_decoding
    4 -> R.string.nova_media_phase_filtering
    5 -> R.string.nova_media_phase_encoding
    6 -> R.string.nova_media_phase_muxing
    7 -> R.string.nova_media_phase_finalizing
    8 -> R.string.nova_media_phase_completed
    else -> R.string.nova_media_conversion_running
}

private fun formatDuration(millis: Long): String {
    val seconds = millis.coerceAtLeast(0) / 1_000
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

private fun formatBitrate(bitsPerSecond: Long): String = "${(bitsPerSecond / 1_000).coerceAtLeast(1)} kbps"

private const val MAX_VISIBLE_STREAMS = 80
private val DOWNLOADABLE_PROTOCOLS = setOf("http", "https", "hls", "dash")
