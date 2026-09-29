package com.nova.downloadmanager.design

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
val NOVATypography = Typography(
    headlineSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = NOVADesignTokens.FontHeadline,
        lineHeight = NOVADesignTokens.FontHeadline * 1.25f,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = NOVADesignTokens.FontTitle,
        lineHeight = NOVADesignTokens.FontTitle * 1.27f,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = NOVADesignTokens.FontMedium,
        lineHeight = NOVADesignTokens.FontMedium * 1.5f,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = NOVADesignTokens.FontMedium,
        lineHeight = NOVADesignTokens.FontMedium * 1.5f,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = NOVADesignTokens.FontBody,
        lineHeight = NOVADesignTokens.FontBody * 1.43f,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = NOVADesignTokens.FontBody,
        lineHeight = NOVADesignTokens.FontBody * 1.43f,
    ),
)
