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

private fun tokenColor(value: Long) = Color(value)

private fun novaLightColors(highContrast: Boolean) = lightColorScheme(
    primary = tokenColor(if (highContrast) NOVADesignTokens.HighContrastLightAccent else NOVADesignTokens.LightAccent),
    onPrimary = tokenColor(if (highContrast) NOVADesignTokens.HighContrastLightOnAccent else NOVADesignTokens.LightOnAccent),
    primaryContainer = tokenColor(if (highContrast) NOVADesignTokens.HighContrastLightAccentMuted else NOVADesignTokens.LightAccentMuted),
    onPrimaryContainer = tokenColor(if (highContrast) NOVADesignTokens.HighContrastLightTextPrimary else NOVADesignTokens.LightTextPrimary),
    secondary = tokenColor(if (highContrast) NOVADesignTokens.HighContrastLightInfo else NOVADesignTokens.LightInfo),
    surface = tokenColor(if (highContrast) NOVADesignTokens.HighContrastLightSurface else NOVADesignTokens.LightSurface),
    onSurface = tokenColor(if (highContrast) NOVADesignTokens.HighContrastLightTextPrimary else NOVADesignTokens.LightTextPrimary),
    surfaceVariant = tokenColor(if (highContrast) NOVADesignTokens.HighContrastLightSurfaceRaised else NOVADesignTokens.LightSurfaceRaised),
    onSurfaceVariant = tokenColor(if (highContrast) NOVADesignTokens.HighContrastLightTextSecondary else NOVADesignTokens.LightTextSecondary),
    error = tokenColor(if (highContrast) NOVADesignTokens.HighContrastLightDanger else NOVADesignTokens.LightDanger),
)

private fun novaDarkColors(highContrast: Boolean) = darkColorScheme(
    primary = tokenColor(if (highContrast) NOVADesignTokens.HighContrastDarkAccent else NOVADesignTokens.DarkAccent),
    onPrimary = tokenColor(if (highContrast) NOVADesignTokens.HighContrastDarkOnAccent else NOVADesignTokens.DarkOnAccent),
    primaryContainer = tokenColor(if (highContrast) NOVADesignTokens.HighContrastDarkAccentMuted else NOVADesignTokens.DarkAccentMuted),
    onPrimaryContainer = tokenColor(if (highContrast) NOVADesignTokens.HighContrastDarkTextPrimary else NOVADesignTokens.DarkTextPrimary),
    secondary = tokenColor(if (highContrast) NOVADesignTokens.HighContrastDarkInfo else NOVADesignTokens.DarkInfo),
    surface = tokenColor(if (highContrast) NOVADesignTokens.HighContrastDarkSurface else NOVADesignTokens.DarkSurface),
    onSurface = tokenColor(if (highContrast) NOVADesignTokens.HighContrastDarkTextPrimary else NOVADesignTokens.DarkTextPrimary),
    surfaceVariant = tokenColor(if (highContrast) NOVADesignTokens.HighContrastDarkSurfaceRaised else NOVADesignTokens.DarkSurfaceRaised),
    onSurfaceVariant = tokenColor(if (highContrast) NOVADesignTokens.HighContrastDarkTextSecondary else NOVADesignTokens.DarkTextSecondary),
    error = tokenColor(if (highContrast) NOVADesignTokens.HighContrastDarkDanger else NOVADesignTokens.DarkDanger),
)

object NOVADimens {
    val ScreenHorizontal: Dp = NOVADesignTokens.ScreenHorizontal
    val Section: Dp = NOVADesignTokens.Section
    val ItemGap: Dp = NOVADesignTokens.ItemGap
    val CompactGap: Dp = NOVADesignTokens.CompactGap
    val MinimumTouchTarget: Dp = NOVADesignTokens.MinimumTouchTarget
}

object NOVAMotion {
    const val ShortMillis: Int = NOVADesignTokens.MotionFastMillis
    const val StandardMillis: Int = NOVADesignTokens.MotionStandardMillis
}

@Composable
fun NOVATheme(
    darkTheme: Boolean,
    useDynamicColor: Boolean,
    highContrast: Boolean = false,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val colorScheme = when {
        useDynamicColor && !highContrast && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && darkTheme -> {
            dynamicDarkColorScheme(context)
        }
        useDynamicColor && !highContrast && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            dynamicLightColorScheme(context)
        }
        darkTheme -> novaDarkColors(highContrast)
        else -> novaLightColors(highContrast)
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = NOVATypography,
        shapes = NOVAShapes,
        content = content,
    )
}
