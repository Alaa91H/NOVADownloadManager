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
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

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
    Accessible.role: Accessible.StatusBar
    Accessible.name: root.engineStatus
        + " · " + root.activeCount + " " + root.t("status.active")
        + " · " + root.formatSpeed(root.totalSpeed)
        + " · " + root.totalCount + " " + root.t("status.downloads")

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
            font.pixelSize: Theme.fontSmall
        }

        Rectangle {
            width: 1
            height: 14
            color: Theme.border
        }

        Text {
            text: root.activeCount + " " + root.t("status.active")
            color: Theme.textSecondary
            font.pixelSize: Theme.fontSmall
        }

        Rectangle {
            width: 1
            height: 14
            color: Theme.border
        }

        Text {
            text: "↓ " + root.formatSpeed(root.totalSpeed)
            color: Theme.textPrimary
            font.pixelSize: Theme.fontSmall
            font.family: "monospace"
        }

        Item { Layout.fillWidth: true }

        Text {
            text: root.totalCount + " " + root.t("status.downloads")
            color: Theme.textMuted
            font.pixelSize: Theme.fontSmall
        }
    }
}
