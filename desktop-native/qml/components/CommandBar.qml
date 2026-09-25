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

    component CompactAction: ToolButton {
        required property string glyph
        required property string label
        implicitWidth: 42
        implicitHeight: 38
        text: glyph
        activeFocusOnTab: true
        Accessible.name: label
        ToolTip.visible: hovered
        ToolTip.text: label

        background: Rectangle {
            radius: Theme.radiusMedium
            color: parent.pressed
                ? Theme.surfaceSelected
                : parent.hovered ? Theme.surfaceHover : Theme.surface
            border.width: parent.activeFocus ? 2 : 1
            border.color: parent.activeFocus ? Theme.focusRing : Theme.border
        }

        contentItem: Text {
            text: parent.text
            color: parent.enabled ? Theme.textSecondary : Theme.textMuted
            opacity: parent.enabled ? 1.0 : 0.45
            font.pixelSize: Theme.fontBody
            font.weight: Font.DemiBold
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }
    }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 14
        anchors.rightMargin: 14
        spacing: 7

        Button {
            id: addButton
            text: "+   " + root.t("action.newDownload")
            enabled: root.engineConnected
            Layout.preferredHeight: 40
            font.pixelSize: Theme.fontBody
            font.weight: Font.DemiBold
            Accessible.name: root.t("action.newDownload")

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

        CompactAction {
            glyph: "▶"
            label: root.t("action.resume")
            enabled: root.hasSelection
                && root.engineConnected
                && root.canResumeSelection
            onClicked: root.resumeRequested()
        }

        CompactAction {
            glyph: "Ⅱ"
            label: root.t("action.pause")
            enabled: root.hasSelection
                && root.engineConnected
                && root.canPauseSelection
            onClicked: root.pauseRequested()
        }

        CompactAction {
            glyph: "↻"
            label: root.failedSelection
                ? root.t("action.retry")
                : root.t("action.redownload")
            enabled: root.hasSelection && root.engineConnected
            onClicked: root.redownloadRequested()
        }

        CompactAction {
            glyph: "⌫"
            label: root.t("action.delete")
            enabled: root.hasSelection && root.engineConnected
            onClicked: root.deleteRequested()
        }

        CompactAction {
            glyph: "▱"
            label: root.t("action.folder")
            enabled: root.hasSelection && root.hasSavePath
            onClicked: root.openFolderRequested()
        }

        CompactAction {
            id: moreButton
            glyph: "•••"
            label: root.t("common.more")
            enabled: root.hasSelection
            onClicked: moreMenu.popup()
        }

        Menu {
            id: moreMenu

            MenuItem {
                text: root.t("action.open")
                enabled: root.canOpenFile
                onTriggered: root.openFileRequested()
            }
            MenuItem {
                text: root.t("action.properties")
                enabled: root.hasSelection
                onTriggered: root.propertiesRequested()
            }
            MenuSeparator {}
            MenuItem {
                text: root.failedSelection
                    ? root.t("action.retry")
                    : root.t("action.redownload")
                enabled: root.hasSelection && root.engineConnected
                onTriggered: root.redownloadRequested()
            }
            MenuItem {
                text: root.t("action.delete")
                enabled: root.hasSelection && root.engineConnected
                onTriggered: root.deleteRequested()
            }
        }

        Item { Layout.fillWidth: true }

        CompactAction {
            glyph: "↻"
            label: root.t("action.refresh")
            onClicked: root.refreshRequested()
        }
    }
}
