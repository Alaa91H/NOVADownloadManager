import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var downloads
    required property var api

    property int selectedIndex: -1
    property string query: ""

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
            Layout.preferredHeight: 58
            Layout.leftMargin: 16
            Layout.rightMargin: 16
            spacing: 12

            ColumnLayout {
                spacing: 0
                Text {
                    text: "Downloads"
                    color: Theme.textPrimary
                    font.pixelSize: 20
                    font.weight: Font.DemiBold
                }
                Text {
                    text: "Manage active, queued and completed transfers"
                    color: Theme.textMuted
                    font.pixelSize: 10
                }
            }

            Item { Layout.fillWidth: true }

            TextField {
                Layout.preferredWidth: 260
                placeholderText: "Search downloads"
                selectByMouse: true
                onTextChanged: root.query = text
            }
        }

        CommandBar {
            Layout.fillWidth: true
            hasSelection: root.selectedIndex >= 0
            onRefreshRequested: root.api.refreshDownloads()
            onPauseRequested: {
                if (root.selectedIndex >= 0)
                    root.api.pauseDownload(root.downloads.taskIdAt(root.selectedIndex))
            }
            onResumeRequested: {
                if (root.selectedIndex >= 0)
                    root.api.resumeDownload(root.downloads.taskIdAt(root.selectedIndex))
            }
            onDeleteRequested: {
                if (root.selectedIndex >= 0) {
                    root.api.deleteDownload(root.downloads.taskIdAt(root.selectedIndex))
                    root.selectedIndex = -1
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.leftMargin: 14
            Layout.rightMargin: 14
            Layout.bottomMargin: 12
            color: Theme.surface
            border.color: Theme.border
            radius: Theme.radiusMedium
            clip: true

            ColumnLayout {
                anchors.fill: parent
                spacing: 0

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 32
                    color: Theme.sidebar

                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 12
                        anchors.rightMargin: 12
                        spacing: 10

                        Text { Layout.fillWidth: true; text: "Name"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                        Text { Layout.preferredWidth: 88; text: "Size"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                        Text { Layout.preferredWidth: 190; text: "Progress"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                        Text { Layout.preferredWidth: 90; text: "Speed"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                        Text { Layout.preferredWidth: 70; text: "ETA"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                        Text { Layout.preferredWidth: 100; text: "Status"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                    }
                }

                ListView {
                    id: list
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds
                    model: root.downloads
                    ScrollBar.vertical: ScrollBar {}

                    delegate: Rectangle {
                        required property int index
                        required property string name
                        required property string status
                        required property double sizeBytes
                        required property double progress
                        required property double speedBytesPerSec
                        required property int etaSeconds

                        width: list.width
                        height: Theme.rowHeight
                        color: root.selectedIndex === index
                            ? Theme.surfaceSelected
                            : mouse.containsMouse ? Theme.surfaceHover : "transparent"

                        Rectangle {
                            anchors.bottom: parent.bottom
                            width: parent.width
                            height: 1
                            color: Theme.border
                            opacity: 0.65
                        }

                        RowLayout {
                            anchors.fill: parent
                            anchors.leftMargin: 12
                            anchors.rightMargin: 12
                            spacing: 10

                            Text {
                                Layout.fillWidth: true
                                text: name
                                color: Theme.textPrimary
                                font.pixelSize: 11
                                elide: Text.ElideMiddle
                            }

                            Text {
                                Layout.preferredWidth: 88
                                text: root.formatBytes(sizeBytes)
                                color: Theme.textSecondary
                                font.pixelSize: 10
                                font.family: "monospace"
                            }

                            RowLayout {
                                Layout.preferredWidth: 190
                                spacing: 8

                                ProgressBar {
                                    Layout.fillWidth: true
                                    from: 0
                                    to: 1
                                    value: progress
                                }

                                Text {
                                    Layout.preferredWidth: 38
                                    text: Math.round(progress * 100) + "%"
                                    color: Theme.textSecondary
                                    font.pixelSize: 10
                                    font.family: "monospace"
                                    horizontalAlignment: Text.AlignRight
                                }
                            }

                            Text {
                                Layout.preferredWidth: 90
                                text: root.formatSpeed(speedBytesPerSec)
                                color: speedBytesPerSec > 0 ? Theme.textPrimary : Theme.textMuted
                                font.pixelSize: 10
                                font.family: "monospace"
                            }

                            Text {
                                Layout.preferredWidth: 70
                                text: root.formatEta(etaSeconds)
                                color: Theme.textSecondary
                                font.pixelSize: 10
                                font.family: "monospace"
                            }

                            Text {
                                Layout.preferredWidth: 100
                                text: status
                                color: status === "completed"
                                    ? Theme.success
                                    : status === "error" ? Theme.danger
                                    : status === "paused" ? Theme.warning
                                    : Theme.textSecondary
                                font.pixelSize: 10
                                font.weight: Font.DemiBold
                            }
                        }

                        MouseArea {
                            id: mouse
                            anchors.fill: parent
                            hoverEnabled: true
                            acceptedButtons: Qt.LeftButton | Qt.RightButton
                            onClicked: root.selectedIndex = index
                        }
                    }

                    footer: Item { width: 1; height: 4 }
                }
            }

            ColumnLayout {
                anchors.centerIn: parent
                spacing: 8
                visible: list.count === 0

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "No downloads yet"
                    color: Theme.textPrimary
                    font.pixelSize: 16
                    font.weight: Font.DemiBold
                }

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: novaApi.connected
                        ? "Start a download or refresh the list."
                        : "Start the NOVA engine to load your downloads."
                    color: Theme.textMuted
                    font.pixelSize: 11
                }
            }
        }
    }
}
