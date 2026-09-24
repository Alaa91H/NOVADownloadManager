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

    readonly property string taskId: downloadItem && downloadItem.taskId ? downloadItem.taskId : ""

    modal: true
    focus: true
    closePolicy: Popup.CloseOnEscape
    width: Math.min(620, parent ? parent.width - 48 : 620)
    title: "Download properties"

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
            errorText = "No download is selected."
            return
        }
        if (nameField.text.trim().length === 0) {
            errorText = "The file name cannot be empty."
            nameField.forceActiveFocus()
            return
        }
        if (urlField.text.trim().length === 0) {
            errorText = "The source URL cannot be empty."
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
            text: "Task metadata"
            color: Theme.textPrimary
            font.pixelSize: 18
            font.weight: Font.DemiBold
        }

        Text {
            Layout.fillWidth: true
            text: "Name and source URL are editable. Download state, engine data and destination are owned by the NOVA engine."
            color: Theme.textMuted
            font.pixelSize: 10
            wrapMode: Text.WordWrap
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                text: "File name"
                color: Theme.textSecondary
                font.pixelSize: 11
                font.weight: Font.DemiBold
            }

            TextField {
                id: nameField
                Layout.fillWidth: true
                selectByMouse: true
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                text: "Source URL"
                color: Theme.textSecondary
                font.pixelSize: 11
                font.weight: Font.DemiBold
            }

            TextArea {
                id: urlField
                Layout.fillWidth: true
                Layout.preferredHeight: 74
                selectByMouse: true
                wrapMode: TextEdit.WrapAnywhere
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

                Text { text: "Task ID"; color: Theme.textMuted; font.pixelSize: 10 }
                Text { text: root.taskId || "—"; color: Theme.textSecondary; font.pixelSize: 10; elide: Text.ElideMiddle; Layout.fillWidth: true }
                Text { text: "Engine"; color: Theme.textMuted; font.pixelSize: 10 }
                Text { text: root.downloadItem.engine || "—"; color: Theme.textSecondary; font.pixelSize: 10 }
                Text { text: "Status"; color: Theme.textMuted; font.pixelSize: 10 }
                Text { text: root.downloadItem.status || "—"; color: Theme.textSecondary; font.pixelSize: 10 }
                Text { text: "Destination"; color: Theme.textMuted; font.pixelSize: 10 }
                Text { text: root.downloadItem.savePath || "—"; color: Theme.textSecondary; font.pixelSize: 10; elide: Text.ElideMiddle; Layout.fillWidth: true }
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
                font.pixelSize: 11
                wrapMode: Text.WordWrap
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 4

            Button {
                text: "Cancel"
                flat: true
                enabled: !root.submitting
                onClicked: root.close()
            }

            Item { Layout.fillWidth: true }

            Button {
                text: root.submitting ? "Saving…" : "Save changes"
                enabled: !root.submitting

                background: Rectangle {
                    radius: Theme.radiusMedium
                    color: parent.enabled ? Theme.accent : Theme.accentMuted
                }

                contentItem: Text {
                    text: parent.text
                    color: parent.enabled ? "white" : Theme.textMuted
                    font.pixelSize: 12
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
