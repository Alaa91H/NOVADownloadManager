import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    signal newDownloadRequested()
    signal resumeRequested()
    signal pauseRequested()
    signal redownloadRequested()
    signal openFileRequested()
    signal openFolderRequested()
    signal propertiesRequested()
    signal deleteRequested()
    signal refreshRequested()

    property bool hasSelection: false
    property bool engineConnected: false
    property bool canPauseSelection: false
    property bool canResumeSelection: false
    property string selectedStatus: ""
    property bool hasSavePath: false

    readonly property string normalizedStatus: selectedStatus.toLowerCase()
    readonly property bool canOpenFile: hasSelection
        && hasSavePath
        && normalizedStatus === "completed"
    readonly property bool failedSelection: normalizedStatus === "failed"
        || normalizedStatus === "error"
        || normalizedStatus === "interrupted"

    implicitHeight: Theme.commandHeight
    color: Theme.window

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 14
        anchors.rightMargin: 14
        spacing: 4

        Button {
            text: "+  New download"
            enabled: root.engineConnected
            font.pixelSize: 12
            font.weight: Font.DemiBold

            background: Rectangle {
                radius: Theme.radiusMedium
                color: parent.enabled
                    ? (parent.pressed ? Qt.darker(Theme.accent, 1.12) : Theme.accent)
                    : Theme.accentMuted
            }

            contentItem: Text {
                text: parent.text
                color: parent.enabled ? "white" : Theme.textMuted
                font: parent.font
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
            }

            onClicked: root.newDownloadRequested()
        }

        ToolSeparator {}

        Button {
            text: "Resume"
            flat: true
            enabled: root.hasSelection
                && root.engineConnected
                && root.canResumeSelection
            onClicked: root.resumeRequested()
        }

        Button {
            text: "Pause"
            flat: true
            enabled: root.hasSelection
                && root.engineConnected
                && root.canPauseSelection
            onClicked: root.pauseRequested()
        }

        Button {
            text: root.failedSelection ? "Retry" : "Redownload"
            flat: true
            enabled: root.hasSelection && root.engineConnected
            onClicked: root.redownloadRequested()
        }

        ToolSeparator {}

        Button {
            text: "Open"
            flat: true
            enabled: root.canOpenFile
            onClicked: root.openFileRequested()
        }

        Button {
            text: "Folder"
            flat: true
            enabled: root.hasSelection && root.hasSavePath
            onClicked: root.openFolderRequested()
        }

        Button {
            text: "Properties"
            flat: true
            enabled: root.hasSelection
            onClicked: root.propertiesRequested()
        }

        Button {
            text: "Delete"
            flat: true
            enabled: root.hasSelection && root.engineConnected
            onClicked: root.deleteRequested()
        }

        Item { Layout.fillWidth: true }

        ToolButton {
            text: "Refresh"
            onClicked: root.refreshRequested()
        }
    }
}
