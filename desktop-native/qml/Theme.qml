pragma Singleton

import QtQuick

QtObject {
    readonly property color window: "#0d1015"
    readonly property color sidebar: "#11151b"
    readonly property color surface: "#151a21"
    readonly property color surfaceHover: "#1b222c"
    readonly property color surfaceSelected: "#202a38"
    readonly property color surfaceRaised: "#1a2029"
    readonly property color border: "#28313d"
    readonly property color borderStrong: "#394657"

    readonly property color textPrimary: "#f3f6fa"
    readonly property color textSecondary: "#a8b1bd"
    readonly property color textMuted: "#737e8d"

    readonly property color accent: "#4f8cff"
    readonly property color accentMuted: "#20345a"
    readonly property color success: "#3fb950"
    readonly property color warning: "#d29922"
    readonly property color danger: "#f85149"

    readonly property int radiusSmall: 4
    readonly property int radiusMedium: 6
    readonly property int radiusLarge: 10
    readonly property int navigationWidth: 216
    readonly property int detailsWidth: 310
    readonly property int commandHeight: 46
    readonly property int rowHeight: 46
}
