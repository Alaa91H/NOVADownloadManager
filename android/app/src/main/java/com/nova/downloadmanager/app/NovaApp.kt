package com.nova.downloadmanager.app

import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nova.downloadmanager.R
import com.nova.downloadmanager.browser.BrowserScreen
import com.nova.downloadmanager.browser.BrowserSettingsSection
import com.nova.downloadmanager.design.NOVADimens
import com.nova.downloadmanager.downloads.CoreReadiness
import com.nova.downloadmanager.downloads.DownloadsUiState
import com.nova.downloadmanager.downloads.DownloadsViewModel

@Composable
fun NOVAApp(
    incomingSharedUrl: String?,
    viewModel: DownloadsViewModel = viewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var selectedDestinationName by rememberSaveable { mutableStateOf(AppDestination.Downloads.name) }
    // Saved UI state can outlive a destination rename or a previous preview build.
    // Never let an unknown restored value abort composition during application launch.
    val selectedDestination = AppDestination.entries.firstOrNull { it.name == selectedDestinationName }
        ?: AppDestination.Downloads

    LaunchedEffect(incomingSharedUrl) {
        incomingSharedUrl?.let(viewModel::receiveSharedUrl)
    }

    uiState.statusMessageRes?.let { messageRes ->
        val message = stringResource(messageRes)
        LaunchedEffect(messageRes) {
            snackbarHostState.showSnackbar(message)
            viewModel.acknowledgeStatusMessage()
        }
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { innerPadding ->
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            val expanded = maxWidth >= 840.dp
            if (expanded) {
                Row(modifier = Modifier.fillMaxSize()) {
                    NOVAAdaptiveNavigation(
                        selected = selectedDestination,
                        expanded = true,
                        onDestinationSelected = { selectedDestinationName = it.name },
                    )
                    NOVAContent(
                        destination = selectedDestination,
                        uiState = uiState,
                        onDismissSharedUrl = viewModel::clearSharedUrl,
                        onRequestDownload = viewModel::requestDownload,
                        onBrowserCaptured = {
                            viewModel.receiveBrowserDownload(it)
                            selectedDestinationName = AppDestination.Downloads.name
                        },
                        modifier = Modifier
                            .fillMaxHeight()
                            .weight(1f),
                    )
                }
            } else {
                Column(modifier = Modifier.fillMaxSize()) {
                    NOVAContent(
                        destination = selectedDestination,
                        uiState = uiState,
                        onDismissSharedUrl = viewModel::clearSharedUrl,
                        onRequestDownload = viewModel::requestDownload,
                        onBrowserCaptured = {
                            viewModel.receiveBrowserDownload(it)
                            selectedDestinationName = AppDestination.Downloads.name
                        },
                        modifier = Modifier.weight(1f),
                    )
                    NOVAAdaptiveNavigation(
                        selected = selectedDestination,
                        expanded = false,
                        onDestinationSelected = { selectedDestinationName = it.name },
                    )
                }
            }
        }
    }
}

@Composable
private fun NOVAContent(
    destination: AppDestination,
    uiState: DownloadsUiState,
    onDismissSharedUrl: () -> Unit,
    onRequestDownload: () -> Unit,
    onBrowserCaptured: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (destination) {
        AppDestination.Downloads -> DownloadsScreen(
            uiState = uiState,
            onDismissSharedUrl = onDismissSharedUrl,
            onRequestDownload = onRequestDownload,
            modifier = modifier,
        )
        AppDestination.Queue -> FoundationDestinationScreen(
            titleRes = R.string.nova_navigation_queue,
            detailRes = R.string.nova_download_empty_detail,
            modifier = modifier,
        )
        AppDestination.Browser -> BrowserScreen(
            onDownloadCaptured = onBrowserCaptured,
            modifier = modifier,
        )
        AppDestination.Settings -> BrowserSettingsSection(modifier = modifier)
    }
}

@Composable
private fun FoundationDestinationScreen(
    titleRes: Int,
    detailRes: Int,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(
            horizontal = NOVADimens.ScreenHorizontal,
            vertical = NOVADimens.Section,
        ),
        verticalArrangement = Arrangement.spacedBy(NOVADimens.ItemGap),
    ) {
        Text(stringResource(titleRes), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(detailRes), style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun DownloadsScreen(
    uiState: DownloadsUiState,
    onDismissSharedUrl: () -> Unit,
    onRequestDownload: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(
            horizontal = NOVADimens.ScreenHorizontal,
            vertical = NOVADimens.ItemGap,
        ),
        verticalArrangement = Arrangement.spacedBy(NOVADimens.ItemGap),
    ) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(NOVADimens.CompactGap)) {
            AssistChip(onClick = {}, label = { Text(stringResource(R.string.nova_filter_all)) })
            AssistChip(onClick = {}, label = { Text(stringResource(R.string.nova_filter_active)) })
            AssistChip(onClick = {}, label = { Text(stringResource(R.string.nova_filter_queue)) })
            AssistChip(onClick = {}, label = { Text(stringResource(R.string.nova_filter_completed)) })
        }

        CoreStatusCard(uiState.readiness)

        uiState.pendingSharedUrl?.let { url ->
            SharedUrlCard(
                url = url,
                onDismiss = onDismissSharedUrl,
                onRequestDownload = onRequestDownload,
            )
        }

        HorizontalDivider()

        if (uiState.tasks.isEmpty()) {
            EmptyDownloadsState()
        } else {
            Text(stringResource(R.string.nova_navigation_downloads))
        }
    }
}

@Composable
private fun CoreStatusCard(readiness: CoreReadiness) {
    val textRes = when (readiness) {
        CoreReadiness.Initializing -> R.string.nova_browser_capture
        CoreReadiness.BridgeNotPackaged,
        CoreReadiness.Unavailable,
        -> R.string.nova_download_unavailable
        CoreReadiness.Ready -> R.string.nova_download_captured
    }
    val text = stringResource(textRes)
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = text },
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(16.dp),
        )
    }
}

@Composable
private fun SharedUrlCard(
    url: String,
    onDismiss: () -> Unit,
    onRequestDownload: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(stringResource(R.string.nova_download_url), style = MaterialTheme.typography.titleMedium)
            Text(redactUrlForDisplay(url), style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onRequestDownload) {
                    Text(stringResource(R.string.nova_download_start_now))
                }
                Button(onClick = onDismiss) { Text(stringResource(R.string.nova_action_close)) }
            }
        }
    }
}

@Composable
private fun EmptyDownloadsState() {
    val title = stringResource(R.string.nova_download_empty_title)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = NOVADimens.Section)
            .semantics { contentDescription = title },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = MaterialTheme.typography.headlineSmall)
        Text(
            stringResource(R.string.nova_download_empty_detail),
            style = MaterialTheme.typography.bodyLarge,
        )
    }
}

private fun redactUrlForDisplay(url: String): String = runCatching {
    val uri = Uri.parse(url)
    buildString {
        append(uri.scheme ?: "")
        append("://")
        append(uri.host ?: "")
        append(uri.path ?: "")
        if (!uri.query.isNullOrEmpty() || !uri.fragment.isNullOrEmpty()) append("…")
    }
}.getOrDefault("…")
