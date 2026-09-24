import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Dialog {
    id: root

    required property var api
    required property var desktop
    required property var settings
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    modal: true
    focus: true
    closePolicy: Popup.CloseOnEscape
    width: Math.min(580, parent ? parent.width - 48 : 580)
    title: root.t("add.title")

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

    function openForUrl(url) {
        resetFields()
        urlField.text = url
        open()
    }

    function submit(startNow) {
        if (submitting)
            return

        if (urlField.text.trim().length === 0) {
            errorText = root.t("add.enterUrl")
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
            text: root.t("add.heading")
            color: Theme.textPrimary
            font.pixelSize: Math.round(18 * Theme.fontScale)
            font.weight: Font.DemiBold
        }

        Text {
            text: root.t("add.subtitle")
            color: Theme.textMuted
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                text: root.t("add.url")
                color: Theme.textSecondary
                font.pixelSize: Theme.fontSmall
                font.weight: Font.DemiBold
            }

            TextField {
                id: urlField
                Layout.fillWidth: true
                placeholderText: "https://example.com/file.zip"
                selectByMouse: true
                inputMethodHints: Qt.ImhUrlCharactersOnly
                LayoutMirroring.enabled: false
                horizontalAlignment: Text.AlignLeft
                Accessible.name: root.t("add.url")
                KeyNavigation.tab: nameField
            }
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
                placeholderText: root.t("add.optionalDetect")
                selectByMouse: true
                Accessible.name: root.t("add.fileName")
                KeyNavigation.tab: pathField
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            Text {
                text: root.t("common.savePath")
                color: Theme.textSecondary
                font.pixelSize: Theme.fontSmall
                font.weight: Font.DemiBold
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 8

                TextField {
                    id: pathField
                    Layout.fillWidth: true
                    placeholderText: root.t("add.optionalDestination")
                    selectByMouse: true
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                    Accessible.name: root.t("common.savePath")
                    KeyNavigation.tab: browseButton
                }

                Button {
                    id: browseButton
                    text: root.t("common.browse")
                    Accessible.name: text
                    KeyNavigation.tab: cancelButton
                    enabled: !root.submitting
                    onClicked: {
                        let suggested = pathField.text.trim()
                        if (suggested.length === 0)
                            suggested = settings.defaultSaveDirectory
                        if (nameField.text.trim().length > 0)
                            suggested += "/" + nameField.text.trim()

                        const chosen = desktop.chooseSaveFile(suggested, "All files (*)")
                        if (chosen.length > 0)
                            pathField.text = chosen
                    }
                }
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
                font.pixelSize: Theme.fontSmall
                wrapMode: Text.WordWrap
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 6

            Button {
                id: cancelButton
                text: root.t("common.cancel")
                Accessible.name: text
                KeyNavigation.tab: queueButton
                flat: true
                enabled: !root.submitting
                onClicked: root.close()
            }

            Item { Layout.fillWidth: true }

            Button {
                id: queueButton
                text: root.t("add.queue")
                Accessible.name: text
                KeyNavigation.tab: downloadNowButton
                enabled: !root.submitting && urlField.text.trim().length > 0
                onClicked: root.submit(false)
            }

            Button {
                id: downloadNowButton
                text: root.submitting ? root.t("add.adding") : root.t("add.downloadNow")
                Accessible.name: text
                KeyNavigation.tab: urlField
                enabled: !root.submitting && urlField.text.trim().length > 0

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
