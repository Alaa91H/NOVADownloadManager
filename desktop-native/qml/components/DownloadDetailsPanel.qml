import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    property var item: ({})
    signal closeRequested()
    signal openFileRequested()
    signal openFolderRequested()
    signal propertiesRequested()

    readonly property bool hasItem: item && item.taskId !== undefined && item.taskId !== ""
    readonly property bool completed: (item.status || "").toLowerCase() === "completed"
    readonly property bool hasSavePath: (item.savePath || "").length > 0
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    color: Theme.surface
    border.color: Theme.border
    radius: Theme.radiusMedium
    clip: true

    function formatBytes(value) {
        if (!value || value <= 0) return "—"
        if (value >= 1024 * 1024 * 1024)
            return (value / (1024 * 1024 * 1024)).toFixed(2) + " GB"
        if (value >= 1024 * 1024)
            return (value / (1024 * 1024)).toFixed(1) + " MB"
        if (value >= 1024)
            return (value / 1024).toFixed(0) + " KB"
        return value + " B"
    }

    function formatSpeed(value) {
        if (!value || value <= 0) return "—"
        if (value >= 1024 * 1024)
            return (value / (1024 * 1024)).toFixed(1) + " MB/s"
        if (value >= 1024)
            return (value / 1024).toFixed(0) + " KB/s"
        return value + " B/s"
    }

    function formatEta(value) {
        if (!value || value <= 0) return "—"
        if (value < 60) return value + "s"
        if (value < 3600) return Math.floor(value / 60) + "m " + (value % 60) + "s"
        return Math.floor(value / 3600) + "h " + Math.floor((value % 3600) / 60) + "m"
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Layout.preferredHeight: 48
            Layout.leftMargin: 14
            Layout.rightMargin: 8

            Text {
                Layout.fillWidth: true
                text: root.t("details.title")
                color: Theme.textPrimary
                font.pixelSize: Theme.fontBody
                font.weight: Font.DemiBold
            }

            ToolButton {
                text: "×"
                onClicked: root.closeRequested()
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 1
            color: Theme.border
        }

        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true

            ColumnLayout {
                width: parent.width
                spacing: 14

                Item { Layout.preferredHeight: 2 }

                Text {
                    Layout.fillWidth: true
                    Layout.leftMargin: 14
                    Layout.rightMargin: 14
                    text: root.item.name || root.t("common.unnamedDownload")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontMedium
                    font.weight: Font.DemiBold
                    wrapMode: Text.WrapAnywhere
                }

                RowLayout {
                    Layout.fillWidth: true
                    Layout.leftMargin: 14
                    Layout.rightMargin: 14

                    Rectangle {
                        implicitWidth: statusText.implicitWidth + 16
                        implicitHeight: 24
                        radius: 12
                        color: root.item.status === "completed"
                            ? Qt.rgba(0.25, 0.73, 0.31, 0.13)
                            : root.item.status === "error" || root.item.status === "failed"
                                ? Qt.rgba(0.97, 0.32, 0.29, 0.13)
                                : root.item.status === "paused"
                                    ? Qt.rgba(0.82, 0.60, 0.13, 0.13)
                                    : Theme.accentMuted

                        Text {
                            id: statusText
                            anchors.centerIn: parent
                            text: root.item.status || "unknown"
                            color: root.item.status === "completed"
                                ? Theme.success
                                : root.item.status === "error" || root.item.status === "failed"
                                    ? Theme.danger
                                    : root.item.status === "paused"
                                        ? Theme.warning
                                        : Theme.textPrimary
                            font.pixelSize: Theme.fontSmall
                            font.weight: Font.DemiBold
                        }
                    }

                    Item { Layout.fillWidth: true }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    Layout.leftMargin: 14
                    Layout.rightMargin: 14
                    spacing: 7

                    ProgressBar {
                        Layout.fillWidth: true
                        from: 0
                        to: 1
                        value: root.item.progress || 0
                    }

                    RowLayout {
                        Layout.fillWidth: true

                        Text {
                            text: root.formatBytes(root.item.downloadedBytes) + " / " + root.formatBytes(root.item.sizeBytes)
                            color: Theme.textSecondary
                            font.pixelSize: Theme.fontSmall
                            font.family: "monospace"
                        }

                        Item { Layout.fillWidth: true }

                        Text {
                            text: Math.round((root.item.progress || 0) * 100) + "%"
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontSmall
                            font.family: "monospace"
                        }
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.leftMargin: 14
                    Layout.rightMargin: 14
                    Layout.preferredHeight: metricsGrid.implicitHeight + 20
                    radius: Theme.radiusMedium
                    color: Theme.surfaceRaised
                    border.color: Theme.border

                    GridLayout {
                        id: metricsGrid
                        anchors.fill: parent
                        anchors.margins: 10
                        columns: 2
                        columnSpacing: 12
                        rowSpacing: 8

                        Text { text: root.t("common.speed"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                        Text { text: root.formatSpeed(root.item.speedBytesPerSec); color: Theme.textPrimary; font.pixelSize: Theme.fontSmall; font.family: "monospace" }
                        Text { text: root.t("common.eta"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                        Text { text: root.formatEta(root.item.etaSeconds); color: Theme.textPrimary; font.pixelSize: Theme.fontSmall; font.family: "monospace" }
                        Text { text: root.t("common.engine"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                        Text { text: root.item.engine || "—"; color: Theme.textPrimary; font.pixelSize: Theme.fontSmall }
                        Text { text: root.t("common.connections"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                        Text { text: root.item.connections || "—"; color: Theme.textPrimary; font.pixelSize: Theme.fontSmall }
                        Text { text: root.t("common.resumable"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                        Text { text: root.item.resumable ? root.t("common.yes") : root.t("common.no"); color: Theme.textPrimary; font.pixelSize: Theme.fontSmall }
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    Layout.leftMargin: 14
                    Layout.rightMargin: 14
                    spacing: 5

                    Text {
                        text: root.t("common.sourceUrl")
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                        font.weight: Font.DemiBold
                    }

                    Text {
                        Layout.fillWidth: true
                        text: root.item.url || "—"
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontSmall
                        wrapMode: Text.WrapAnywhere
                    }

                    Text {
                        Layout.topMargin: 8
                        text: root.t("common.savePath")
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                        font.weight: Font.DemiBold
                    }

                    Text {
                        Layout.fillWidth: true
                        text: root.item.savePath || "—"
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontSmall
                        wrapMode: Text.WrapAnywhere
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.leftMargin: 14
                    Layout.rightMargin: 14
                    Layout.preferredHeight: errorDetails.implicitHeight + 18
                    visible: (root.item.errorMessage || "").length > 0
                    radius: Theme.radiusMedium
                    color: Qt.rgba(0.97, 0.32, 0.29, 0.08)
                    border.color: Theme.danger

                    Text {
                        id: errorDetails
                        anchors.fill: parent
                        anchors.margins: 9
                        text: root.item.errorMessage || ""
                        color: Theme.danger
                        font.pixelSize: Theme.fontSmall
                        wrapMode: Text.WordWrap
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    Layout.leftMargin: 14
                    Layout.rightMargin: 14
                    spacing: 6

                    Button {
                        text: root.t("details.openFile")
                        enabled: root.completed && root.hasSavePath
                        onClicked: root.openFileRequested()
                    }

                    Button {
                        text: root.t("details.showFolder")
                        enabled: root.hasSavePath
                        onClicked: root.openFolderRequested()
                    }
                }

                Button {
                    Layout.leftMargin: 14
                    Layout.rightMargin: 14
                    text: root.t("action.properties")
                    enabled: root.hasItem
                    onClicked: root.propertiesRequested()
                }

                Item { Layout.preferredHeight: 12 }
            }
        }
    }
}
