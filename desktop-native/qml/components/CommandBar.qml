import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    signal newDownloadRequested()
    signal resumeRequested()
    signal pauseRequested()
    signal deleteRequested()
    signal refreshRequested()

    property bool hasSelection: false

    implicitHeight: Theme.commandHeight
    color: Theme.window

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 14
        anchors.rightMargin: 14
        spacing: 6

        Button {
            text: "+  New download"
            font.pixelSize: 12
            font.weight: Font.DemiBold

            background: Rectangle {
                radius: Theme.radiusMedium
                color: parent.pressed ? Qt.darker(Theme.accent, 1.12) : Theme.accent
            }

            contentItem: Text {
                text: parent.text
                color: "white"
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
            onClicked: root.resumeRequested()
        }

        Button {
            text: "Pause"
            flat: true
            enabled: root.hasSelection
            onClicked: root.pauseRequested()
        }

        Button {
            text: "Delete"
            flat: true
            enabled: root.hasSelection
            onClicked: root.deleteRequested()
        }

        ToolButton {
            text: "•••"
            enabled: root.hasSelection
        }

        Item { Layout.fillWidth: true }

        ToolButton {
            text: "Refresh"
            onClicked: root.refreshRequested()
        }
    }
}
