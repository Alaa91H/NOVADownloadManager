import QtQuick
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    property bool engineConnected: false
    property string engineStatus: "Connecting…"
    property int activeCount: 0
    property int totalCount: 0
    property double totalSpeed: 0

    function formatSpeed(bytesPerSecond) {
        if (bytesPerSecond >= 1024 * 1024 * 1024)
            return (bytesPerSecond / (1024 * 1024 * 1024)).toFixed(1) + " GB/s"
        if (bytesPerSecond >= 1024 * 1024)
            return (bytesPerSecond / (1024 * 1024)).toFixed(1) + " MB/s"
        if (bytesPerSecond >= 1024)
            return (bytesPerSecond / 1024).toFixed(0) + " KB/s"
        return Math.round(bytesPerSecond) + " B/s"
    }

    implicitHeight: 30
    color: Theme.sidebar

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 12
        anchors.rightMargin: 12
        spacing: 10

        Rectangle {
            width: 7
            height: 7
            radius: 4
            color: root.engineConnected ? Theme.success : Theme.danger
        }

        Text {
            text: root.engineStatus
            color: Theme.textSecondary
            font.pixelSize: 10
        }

        Rectangle {
            width: 1
            height: 14
            color: Theme.border
        }

        Text {
            text: root.activeCount + " active"
            color: Theme.textSecondary
            font.pixelSize: 10
        }

        Rectangle {
            width: 1
            height: 14
            color: Theme.border
        }

        Text {
            text: "↓ " + root.formatSpeed(root.totalSpeed)
            color: Theme.textPrimary
            font.pixelSize: 10
            font.family: "monospace"
        }

        Item { Layout.fillWidth: true }

        Text {
            text: root.totalCount + " downloads"
            color: Theme.textMuted
            font.pixelSize: 10
        }
    }
}
