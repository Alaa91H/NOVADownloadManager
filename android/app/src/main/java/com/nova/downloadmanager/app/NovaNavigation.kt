package com.nova.downloadmanager.app

import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import com.nova.downloadmanager.design.NOVAIcons

enum class AppDestination(
    val label: String,
    val icon: ImageVector,
) {
    Downloads("Downloads", NOVAIcons.Downloads),
    Queue("Queue", NOVAIcons.Queue),
    Settings("Settings", NOVAIcons.Settings),
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
                NavigationRailItem(
                    selected = destination == selected,
                    onClick = { onDestinationSelected(destination) },
                    icon = {
                        Icon(
                            imageVector = destination.icon,
                            contentDescription = destination.label,
                        )
                    },
                    label = { Text(destination.label) },
                )
            }
        }
    } else {
        NavigationBar(modifier = modifier) {
            AppDestination.entries.forEach { destination ->
                NavigationBarItem(
                    selected = destination == selected,
                    onClick = { onDestinationSelected(destination) },
                    icon = {
                        Icon(
                            imageVector = destination.icon,
                            contentDescription = destination.label,
                        )
                    },
                    label = { Text(destination.label) },
                )
            }
        }
    }
}
