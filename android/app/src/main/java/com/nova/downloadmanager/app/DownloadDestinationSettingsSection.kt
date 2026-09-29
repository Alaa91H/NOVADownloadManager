package com.nova.downloadmanager.app

import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nova.downloadmanager.R
import com.nova.downloadmanager.design.NOVADimens
import com.nova.downloadmanager.storage.DownloadDestination
import com.nova.downloadmanager.storage.DownloadDestinationStore

@Composable
fun DownloadDestinationSettingsSection(modifier: Modifier = Modifier) {
    val context = LocalContext.current.applicationContext
    val destinationStore = remember(context) { DownloadDestinationStore(context) }
    var selected by remember { mutableStateOf(destinationStore.selected()) }
    var selectionFailed by remember { mutableStateOf(false) }
    val folderPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
        if (uri != null) {
            selectionFailed = runCatching { destinationStore.selectTree(uri) }.isFailure
            if (!selectionFailed) selected = destinationStore.selected()
        }
    }

    Column(
        modifier = modifier.padding(
            horizontal = NOVADimens.ScreenHorizontal,
            vertical = NOVADimens.Section,
        ),
        verticalArrangement = Arrangement.spacedBy(NOVADimens.ItemGap),
    ) {
        Text(
            text = stringResource(R.string.nova_storage_title),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = stringResource(R.string.nova_storage_description),
            style = MaterialTheme.typography.bodyMedium,
        )
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                DestinationOption(
                    title = stringResource(R.string.nova_storage_app_private),
                    description = stringResource(R.string.nova_storage_app_private_detail),
                    selected = selected is DownloadDestination.AppPrivate,
                    onClick = {
                        selectionFailed = runCatching {
                            destinationStore.select(DownloadDestination.AppPrivate)
                        }.isFailure
                        if (!selectionFailed) selected = DownloadDestination.AppPrivate
                    },
                )
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    DestinationOption(
                        title = stringResource(R.string.nova_storage_public_downloads),
                        description = stringResource(R.string.nova_storage_public_downloads_detail),
                        selected = selected is DownloadDestination.MediaStoreDownloads,
                        onClick = {
                            selectionFailed = runCatching {
                                destinationStore.select(DownloadDestination.MediaStoreDownloads)
                            }.isFailure
                            if (!selectionFailed) selected = DownloadDestination.MediaStoreDownloads
                        },
                    )
                }
                DestinationOption(
                    title = stringResource(R.string.nova_storage_selected_folder),
                    description = stringResource(R.string.nova_storage_selected_folder_detail),
                    selected = selected is DownloadDestination.SafTree,
                    onClick = { folderPicker.launch(null) },
                )
            }
        }
        if (selected is DownloadDestination.SafTree) {
            Button(onClick = { folderPicker.launch(null) }) {
                Text(stringResource(R.string.nova_storage_choose_folder))
            }
        }
        if (selectionFailed) {
            Text(
                text = stringResource(R.string.nova_storage_permission_error),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun DestinationOption(
    title: String,
    description: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Column(
            modifier = Modifier.padding(start = NOVADimens.CompactGap),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(description, style = MaterialTheme.typography.bodySmall)
        }
    }
}
