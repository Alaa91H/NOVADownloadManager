package com.nova.downloadmanager.app

import androidx.annotation.StringRes
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import com.nova.downloadmanager.R
import com.nova.downloadmanager.design.NOVAIcons

enum class AppDestination(
    @param:StringRes val labelRes: Int,
    val icon: ImageVector,
) {
    Downloads(R.string.nova_navigation_downloads, NOVAIcons.Downloads),
    Queue(R.string.nova_navigation_queue, NOVAIcons.Queue),
    Browser(R.string.nova_navigation_browser, NOVAIcons.Browser),
    Settings(R.string.nova_navigation_settings, NOVAIcons.Settings),
}

@Composable
fun NOVAAdaptiveNavigation(
    selected: AppDestination,
    expanded: Boolean,
    onDestinationSelected: (AppDestination) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (expanded) {
        NavigationRail(modifier = modifier) {
            AppDestination.entries.forEach { destination ->
                val label = stringResource(destination.labelRes)
                NavigationRailItem(
                    selected = destination == selected,
                    onClick = { onDestinationSelected(destination) },
                    icon = {
                        Icon(
                            imageVector = destination.icon,
                            contentDescription = label,
                        )
                    },
                    label = { Text(label) },
                )
            }
        }
    } else {
        NavigationBar(modifier = modifier) {
            AppDestination.entries.forEach { destination ->
                val label = stringResource(destination.labelRes)
                NavigationBarItem(
                    selected = destination == selected,
                    onClick = { onDestinationSelected(destination) },
                    icon = {
                        Icon(
                            imageVector = destination.icon,
                            contentDescription = label,
                        )
                    },
                    label = { Text(label) },
                )
            }
        }
    }
}
