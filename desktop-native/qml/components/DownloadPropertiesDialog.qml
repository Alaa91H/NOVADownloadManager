import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Dialog {
    id: root

    required property var api

    property var downloadItem: ({})
    property bool submitting: false
    property string errorText: ""
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    readonly property string taskId: downloadItem && downloadItem.taskId ? downloadItem.taskId : ""

    modal: true
    focus: true
    closePolicy: Popup.CloseOnEscape
    width: Math.min(620, parent ? parent.width - 48 : 620)
    title: root.t("properties.title")

    function openFor(item) {
        downloadItem = item || ({})
        nameField.text = downloadItem.name || ""
        urlField.text = downloadItem.url || ""
        errorText = ""
        submitting = false
        open()
        nameField.forceActiveFocus()
    }

    function submit() {
        if (submitting)
            return
        if (taskId.length === 0) {
            errorText = root.t("properties.noSelection")
            return
        }
        if (nameField.text.trim().length === 0) {
            errorText = root.t("properties.emptyName")
            nameField.forceActiveFocus()
            return
        }
        if (urlField.text.trim().length === 0) {
            errorText = root.t("properties.emptyUrl")
            urlField.forceActiveFocus()
            return
        }

        submitting = true
        errorText = ""
        api.updateDownloadMetadata(taskId, nameField.text, urlField.text)
    }

    background: Rectangle {
        color: Theme.surfaceRaised
        border.color: Theme.borderStrong
        border.width: 1
        radius: Theme.radiusLarge
    }

    contentItem: ColumnLayout {
        spacing: 14

        Text {
            text: root.t("properties.heading")
            color: Theme.textPrimary
            font.pixelSize: Math.round(18 * Theme.fontScale)
            font.weight: Font.DemiBold
        }

        Text {
            Layout.fillWidth: true
            text: root.t("properties.subtitle")
            color: Theme.textMuted
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.WordWrap
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                text: root.t("add.fileName")
                color: Theme.textSecondary
                font.pixelSize: Theme.fontSmall
                font.weight: Font.DemiBold
            }

            TextField {
                id: nameField
                Layout.fillWidth: true
                selectByMouse: true
                Accessible.name: root.t("add.fileName")
                KeyNavigation.tab: urlField
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                text: root.t("common.sourceUrl")
                color: Theme.textSecondary
                font.pixelSize: Theme.fontSmall
                font.weight: Font.DemiBold
            }

            TextArea {
                id: urlField
                Layout.fillWidth: true
                Layout.preferredHeight: 74
                selectByMouse: true
                wrapMode: TextEdit.WrapAnywhere
                LayoutMirroring.enabled: false
                horizontalAlignment: Text.AlignLeft
                Accessible.name: root.t("common.sourceUrl")
                KeyNavigation.tab: cancelButton
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: infoGrid.implicitHeight + 20
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            GridLayout {
                id: infoGrid
                anchors.fill: parent
                anchors.margins: 10
                columns: 2
                columnSpacing: 12
                rowSpacing: 7

                Text { text: root.t("common.taskId"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                Text { text: root.taskId || "—"; color: Theme.textSecondary; font.pixelSize: Theme.fontSmall; elide: Text.ElideMiddle; Layout.fillWidth: true }
                Text { text: root.t("common.engine"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                Text { text: root.downloadItem.engine || "—"; color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                Text { text: root.t("common.status"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                Text { text: root.downloadItem.status || "—"; color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                Text { text: root.t("common.destination"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                Text {
                    text: root.downloadItem.savePath || "—"
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                    elide: Text.ElideMiddle
                    Layout.fillWidth: true
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: errorLabel.implicitHeight + 16
            visible: root.errorText.length > 0
            radius: Theme.radiusMedium
            color: Qt.rgba(0.97, 0.32, 0.29, 0.10)
            border.color: Theme.danger

            Text {
                id: errorLabel
                anchors.fill: parent
                anchors.margins: 8
                text: root.errorText
                color: Theme.danger
                font.pixelSize: Theme.fontSmall
                wrapMode: Text.WordWrap
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 4

            Button {
                id: cancelButton
                text: root.t("common.cancel")
                Accessible.name: text
                KeyNavigation.tab: saveButton
                flat: true
                enabled: !root.submitting
                onClicked: root.close()
            }

            Item { Layout.fillWidth: true }

            Button {
                id: saveButton
                text: root.submitting ? root.t("properties.saving") : root.t("properties.save")
                Accessible.name: text
                KeyNavigation.tab: nameField
                enabled: !root.submitting

                background: Rectangle {
                    radius: Theme.radiusMedium
                    color: parent.enabled ? Theme.accent : Theme.accentMuted
                }

                contentItem: Text {
                    text: parent.text
                    color: parent.enabled ? "white" : Theme.textMuted
                    font.pixelSize: Theme.fontBody
                    font.weight: Font.DemiBold
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }

                onClicked: root.submit()
            }
        }
    }

    Connections {
        target: root.api

        function onDownloadUpdated(taskId) {
            if (!root.visible || taskId !== root.taskId)
                return
            root.submitting = false
            root.close()
        }

        function onDownloadUpdateFailed(message) {
            if (!root.visible)
                return
            root.submitting = false
            root.errorText = message
        }
    }
}
