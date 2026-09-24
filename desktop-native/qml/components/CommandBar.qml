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
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

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
            text: "+  " + root.t("action.newDownload")
            enabled: root.engineConnected
            font.pixelSize: Theme.fontBody
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
            text: root.t("action.resume")
            flat: true
            activeFocusOnTab: true
            Accessible.name: text
            enabled: root.hasSelection
                && root.engineConnected
                && root.canResumeSelection
            onClicked: root.resumeRequested()
        }

        Button {
            text: root.t("action.pause")
            flat: true
            activeFocusOnTab: true
            Accessible.name: text
            enabled: root.hasSelection
                && root.engineConnected
                && root.canPauseSelection
            onClicked: root.pauseRequested()
        }

        Button {
            text: root.failedSelection ? root.t("action.retry") : root.t("action.redownload")
            flat: true
            activeFocusOnTab: true
            Accessible.name: text
            enabled: root.hasSelection && root.engineConnected
            onClicked: root.redownloadRequested()
        }

        ToolSeparator {}

        Button {
            text: root.t("action.open")
            flat: true
            activeFocusOnTab: true
            Accessible.name: text
            enabled: root.canOpenFile
            onClicked: root.openFileRequested()
        }

        Button {
            text: root.t("action.folder")
            flat: true
            activeFocusOnTab: true
            Accessible.name: text
            enabled: root.hasSelection && root.hasSavePath
            onClicked: root.openFolderRequested()
        }

        Button {
            text: root.t("action.properties")
            flat: true
            activeFocusOnTab: true
            Accessible.name: text
            enabled: root.hasSelection
            onClicked: root.propertiesRequested()
        }

        Button {
            text: root.t("action.delete")
            flat: true
            activeFocusOnTab: true
            Accessible.name: text
            enabled: root.hasSelection && root.engineConnected
            onClicked: root.deleteRequested()
        }

        Item { Layout.fillWidth: true }

        ToolButton {
            text: root.t("action.refresh")
            activeFocusOnTab: true
            Accessible.name: text
            onClicked: root.refreshRequested()
        }
    }
}
