package com.nova.downloadmanager.design

import android.os.Build
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

private val NovaLightColors = lightColorScheme(
    primary = Color(0xFF005AC1),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFD9E2FF),
    onPrimaryContainer = Color(0xFF001A41),
    secondary = Color(0xFF4E607D),
    surface = Color(0xFFF9F9FF),
    onSurface = Color(0xFF191C20),
    surfaceVariant = Color(0xFFE0E2EC),
    onSurfaceVariant = Color(0xFF43474E),
    error = Color(0xFFBA1A1A),
)

private val NovaDarkColors = darkColorScheme(
    primary = Color(0xFFB0C6FF),
    onPrimary = Color(0xFF002E69),
    primaryContainer = Color(0xFF004494),
    onPrimaryContainer = Color(0xFFD9E2FF),
    secondary = Color(0xFFB7C8E8),
    surface = Color(0xFF111318),
    onSurface = Color(0xFFE1E2E9),
    surfaceVariant = Color(0xFF43474E),
    onSurfaceVariant = Color(0xFFC3C6D0),
    error = Color(0xFFFFB4AB),
)

object NOVADimens {
    val ScreenHorizontal: Dp = 20.dp
    val Section: Dp = 24.dp
    val ItemGap: Dp = 12.dp
    val CompactGap: Dp = 8.dp
    val MinimumTouchTarget: Dp = 48.dp
}

object NOVAMotion {
    const val ShortMillis: Int = 150
    const val StandardMillis: Int = 250
}

@Composable
fun NOVATheme(
    darkTheme: Boolean,
    useDynamicColor: Boolean,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val colorScheme = when {
        useDynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && darkTheme -> {
            dynamicDarkColorScheme(context)
        }
        useDynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            dynamicLightColorScheme(context)
        }
        darkTheme -> NovaDarkColors
        else -> NovaLightColors
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = NOVATypography,
        shapes = NOVAShapes,
        content = content,
    )
}
