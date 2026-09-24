import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Dialog {
    id: root

    required property var api

    modal: true
    focus: true
    closePolicy: Popup.CloseOnEscape
    width: Math.min(580, parent ? parent.width - 48 : 580)
    title: "New download"

    property bool submitting: false
    property string errorText: ""

    function resetFields() {
        urlField.clear()
        nameField.clear()
        pathField.clear()
        errorText = ""
        submitting = false
    }

    function openNew() {
        resetFields()
        open()
    }

    function submit(startNow) {
        if (submitting)
            return

        if (urlField.text.trim().length === 0) {
            errorText = "Enter a download URL."
            urlField.forceActiveFocus()
            return
        }

        errorText = ""
        submitting = true
        api.createDownload(
            urlField.text,
            nameField.text,
            pathField.text,
            startNow
        )
    }

    onOpened: urlField.forceActiveFocus()

    background: Rectangle {
        color: Theme.surfaceRaised
        border.color: Theme.borderStrong
        border.width: 1
        radius: Theme.radiusLarge
    }

    contentItem: ColumnLayout {
        spacing: 14

        Text {
            text: "Add a direct download"
            color: Theme.textPrimary
            font.pixelSize: 18
            font.weight: Font.DemiBold
        }

        Text {
            text: "NOVA will resolve redirects and download metadata through the existing engine."
            color: Theme.textMuted
            font.pixelSize: 11
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                text: "URL"
                color: Theme.textSecondary
                font.pixelSize: 11
                font.weight: Font.DemiBold
            }

            TextField {
                id: urlField
                Layout.fillWidth: true
                placeholderText: "https://example.com/file.zip"
                selectByMouse: true
                inputMethodHints: Qt.ImhUrlCharactersOnly
            }
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
                placeholderText: "Optional — detect automatically"
                selectByMouse: true
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                text: "Save path"
                color: Theme.textSecondary
                font.pixelSize: 11
                font.weight: Font.DemiBold
            }

            TextField {
                id: pathField
                Layout.fillWidth: true
                placeholderText: "Optional — use NOVA default destination"
                selectByMouse: true
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: errorTextLabel.implicitHeight + 16
            visible: root.errorText.length > 0
            radius: Theme.radiusMedium
            color: Qt.rgba(0.97, 0.32, 0.29, 0.10)
            border.color: Theme.danger

            Text {
                id: errorTextLabel
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
            Layout.topMargin: 6

            Button {
                text: "Cancel"
                flat: true
                enabled: !root.submitting
                onClicked: root.close()
            }

            Item { Layout.fillWidth: true }

            Button {
                text: "Add to queue"
                enabled: !root.submitting && urlField.text.trim().length > 0
                onClicked: root.submit(false)
            }

            Button {
                text: root.submitting ? "Adding…" : "Download now"
                enabled: !root.submitting && urlField.text.trim().length > 0

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

                onClicked: root.submit(true)
            }
        }
    }

    Connections {
        target: root.api

        function onDownloadCreated(taskId) {
            if (!root.visible)
                return

            root.submitting = false
            root.close()
            root.resetFields()
        }

        function onDownloadCreationFailed(message) {
            if (!root.visible)
                return

            root.submitting = false
            root.errorText = message
        }
    }
}
