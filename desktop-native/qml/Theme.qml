pragma Singleton

import QtQuick

QtObject {
    property bool darkMode: true
    property bool highContrast: false
    property bool reducedMotion: false
    property real fontScale: 1.0

    readonly property color window: highContrast
        ? (darkMode ? "#000000" : "#ffffff")
        : (darkMode ? "#0d1015" : "#f4f6f8")
    readonly property color sidebar: highContrast
        ? (darkMode ? "#050505" : "#f7f7f7")
        : (darkMode ? "#11151b" : "#ffffff")
    readonly property color surface: highContrast
        ? (darkMode ? "#0a0a0a" : "#ffffff")
        : (darkMode ? "#151a21" : "#ffffff")
    readonly property color surfaceHover: highContrast
        ? (darkMode ? "#202020" : "#e8e8e8")
        : (darkMode ? "#1b222c" : "#edf2f7")
    readonly property color surfaceSelected: highContrast
        ? (darkMode ? "#282828" : "#dedede")
        : (darkMode ? "#202a38" : "#dfe9f8")
    readonly property color surfaceRaised: highContrast
        ? (darkMode ? "#101010" : "#fafafa")
        : (darkMode ? "#1a2029" : "#f8fafc")
    readonly property color border: highContrast
        ? (darkMode ? "#ffffff" : "#000000")
        : (darkMode ? "#28313d" : "#d9e0e8")
    readonly property color borderStrong: highContrast
        ? (darkMode ? "#ffffff" : "#000000")
        : (darkMode ? "#394657" : "#aeb9c6")

    readonly property color textPrimary: darkMode ? "#f3f6fa" : "#18212c"
    readonly property color textSecondary: darkMode ? "#a8b1bd" : "#4d5b6b"
    readonly property color textMuted: darkMode ? "#737e8d" : "#718096"

    readonly property color accent: highContrast
        ? (darkMode ? "#66a3ff" : "#0047b3")
        : "#4f8cff"
    readonly property color accentMuted: darkMode ? "#20345a" : "#dce9ff"
    readonly property color success: darkMode ? "#3fb950" : "#188038"
    readonly property color warning: darkMode ? "#d29922" : "#9a6700"
    readonly property color danger: darkMode ? "#f85149" : "#c62828"
    readonly property color focusRing: highContrast ? accent : Qt.rgba(accent.r, accent.g, accent.b, 0.85)

    readonly property int radiusSmall: 4
    readonly property int radiusMedium: 6
    readonly property int radiusLarge: 10
    readonly property int navigationWidth: Math.round(216 * Math.max(1.0, fontScale))
    readonly property int detailsWidth: Math.round(310 * Math.max(1.0, fontScale))
    readonly property int commandHeight: Math.round(46 * Math.max(1.0, fontScale))
    readonly property int rowHeight: Math.round(46 * Math.max(1.0, fontScale))

    readonly property int fontTiny: Math.round(9 * fontScale)
    readonly property int fontSmall: Math.round(10 * fontScale)
    readonly property int fontBody: Math.round(12 * fontScale)
    readonly property int fontMedium: Math.round(14 * fontScale)
    readonly property int fontTitle: Math.round(21 * fontScale)

    readonly property int animationFast: reducedMotion ? 0 : 100
    readonly property int animationNormal: reducedMotion ? 0 : 180
}
