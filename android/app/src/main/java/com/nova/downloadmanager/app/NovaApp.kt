package com.nova.downloadmanager.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
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

    LaunchedEffect(uiState.statusMessage) {
        uiState.statusMessage?.let {
            snackbarHostState.showSnackbar(it)
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
    modifier: Modifier = Modifier,
) {
    when (destination) {
        AppDestination.Downloads -> DownloadsScreen(
            uiState = uiState,
            onDismissSharedUrl = onDismissSharedUrl,
            modifier = modifier,
        )
        AppDestination.Queue -> FoundationDestinationScreen(
            title = "Queue",
            detail = "Queued work will be shown here after task snapshots are supplied by the shared NOVA core.",
            modifier = modifier,
        )
        AppDestination.Settings -> FoundationDestinationScreen(
            title = "Settings",
            detail = "Storage, network, notification, and bridge settings will be added through Android-native adapters.",
            modifier = modifier,
        )
    }
}

@Composable
private fun FoundationDestinationScreen(title: String, detail: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.padding(
            horizontal = NOVADimens.ScreenHorizontal,
            vertical = NOVADimens.Section,
        ),
        verticalArrangement = Arrangement.spacedBy(NOVADimens.ItemGap),
    ) {
        Text(title, style = MaterialTheme.typography.headlineSmall)
        Text(detail, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun DownloadsScreen(
    uiState: DownloadsUiState,
    onDismissSharedUrl: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(
            horizontal = NOVADimens.ScreenHorizontal,
            vertical = NOVADimens.ItemGap,
        ),
        verticalArrangement = Arrangement.spacedBy(NOVADimens.ItemGap),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(NOVADimens.CompactGap)) {
            AssistChip(onClick = {}, label = { Text("All") })
            AssistChip(onClick = {}, label = { Text("Active") })
            AssistChip(onClick = {}, label = { Text("Queue") })
            AssistChip(onClick = {}, label = { Text("Completed") })
        }

        CoreStatusCard(uiState.readiness)

        uiState.pendingSharedUrl?.let { url ->
            SharedUrlCard(url = url, onDismiss = onDismissSharedUrl)
        }

        HorizontalDivider()

        if (uiState.tasks.isEmpty()) {
            EmptyDownloadsState()
        } else {
            // Task rows will be driven by canonical core snapshots after the
            // download-core extraction and UniFFI task stream are complete.
            Text("Tasks will appear here.")
        }
    }
}

@Composable
private fun CoreStatusCard(readiness: CoreReadiness) {
    val text = when (readiness) {
        CoreReadiness.Initializing -> "Preparing NOVA core"
        CoreReadiness.BridgeNotPackaged -> "The typed NOVA core bridge is being prepared for Android. No download engine runs in Kotlin."
        CoreReadiness.Ready -> "NOVA core is ready"
        CoreReadiness.Unavailable -> "NOVA core is unavailable. Check diagnostics before starting a download."
    }
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.secondaryContainer,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = "NOVA core status: $text" },
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(16.dp),
        )
    }
}

@Composable
private fun SharedUrlCard(url: String, onDismiss: () -> Unit) {
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
            Text("Shared link", style = MaterialTheme.typography.titleMedium)
            Text(url, style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onDismiss) { Text("Dismiss") }
            }
        }
    }
}

@Composable
private fun EmptyDownloadsState() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = NOVADimens.Section)
            .semantics { contentDescription = "No downloads yet" },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("No downloads yet", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Paste a URL or share a link with NOVA to start your first download.",
            style = MaterialTheme.typography.bodyLarge,
        )
        Button(onClick = {}) { Text("Add download") }
    }
}
