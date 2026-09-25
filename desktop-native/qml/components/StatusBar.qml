import QtQuick
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    property bool engineConnected: false
    property string engineStatus: ""
    property int activeCount: 0
    property int queuedCount: 0
    property int completedCount: 0
    property int failedCount: 0
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

    implicitHeight: Math.round(38 * Math.max(0.88, Theme.densityScale))
    color: Theme.sidebar
    border.color: Theme.border
    Accessible.role: Accessible.StatusBar
    Accessible.name: root.engineStatus
        + " · " + root.activeCount + " " + root.t("nav.active")
        + " · " + root.queuedCount + " " + root.t("nav.queued")
        + " · " + root.completedCount + " " + root.t("nav.completed")
        + " · " + root.failedCount + " " + root.t("nav.failed")
        + " · " + root.formatSpeed(root.totalSpeed)

    component MetricText: Text {
        color: Theme.textSecondary
        font.pixelSize: Theme.fontSmall
        verticalAlignment: Text.AlignVCenter
    }

    component Divider: Rectangle {
        Layout.preferredWidth: 1
        Layout.preferredHeight: 18
        color: Theme.borderStrong
    }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 14
        anchors.rightMargin: 14
        spacing: 14

        Rectangle {
            width: 8
            height: 8
            radius: 4
            color: root.engineConnected ? Theme.success : Theme.danger
        }

        MetricText {
            text: "⌁  " + root.formatSpeed(root.totalSpeed)
            color: Theme.textPrimary
            font.weight: Font.DemiBold
        }

        Divider {}

        MetricText { text: root.t("nav.active") + ": " + root.activeCount }
        Divider {}
        MetricText { text: root.t("nav.queued") + ": " + root.queuedCount }
        Divider {}
        MetricText { text: root.t("nav.completed") + ": " + root.completedCount }
        Divider {}
        MetricText { text: root.t("nav.failed") + ": " + root.failedCount }
        Divider {}
        MetricText { text: root.t("status.downloads") + ": " + root.totalCount }

        Item { Layout.fillWidth: true }

        MetricText {
            text: "↓  " + root.formatSpeed(root.totalSpeed)
            color: Theme.textPrimary
            font.family: "monospace"
        }
    }
}
