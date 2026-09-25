import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Dialog {
    id: root

    property string downloadName: ""
    property bool retryMode: false
    property string languageToken: i18n.language
    signal confirmed()

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    modal: true
    focus: true
    closePolicy: Popup.CloseOnEscape
    width: Math.min(460, parent ? parent.width - 48 : 460)
    title: retryMode ? root.t("redownload.retryTitle") : root.t("redownload.title")
    onOpened: cancelButton.forceActiveFocus()

    background: Rectangle {
        color: Theme.surfaceRaised
        border.color: Theme.borderStrong
        border.width: 1
        radius: Theme.radiusLarge
    }

    contentItem: ColumnLayout {
        spacing: 14

        Text {
            Layout.fillWidth: true
            text: root.retryMode
                ? root.t("redownload.retryQuestion")
                : root.t("redownload.question")
            color: Theme.textPrimary
            font.pixelSize: Math.round(16 * Theme.fontScale)
            font.weight: Font.DemiBold
            wrapMode: Text.WordWrap
        }

        Text {
            Layout.fillWidth: true
            text: root.downloadName.length > 0 ? root.downloadName : root.t("common.selectedDownload")
            color: Theme.textSecondary
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.WrapAnywhere
        }

        Text {
            Layout.fillWidth: true
            text: root.t("redownload.warning")
            color: Theme.warning
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.WordWrap
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 6

            Item { Layout.fillWidth: true }

            Button {
                id: cancelButton
                text: root.t("common.cancel")
                Accessible.name: text
                KeyNavigation.tab: confirmButton
                KeyNavigation.backtab: confirmButton
                onClicked: root.close()
            }

            Button {
                id: confirmButton
                text: root.retryMode ? root.t("action.retry") : root.t("action.redownload")
                Accessible.name: text
                KeyNavigation.tab: cancelButton
                KeyNavigation.backtab: cancelButton

                background: Rectangle {
                    radius: Theme.radiusMedium
                    color: parent.pressed ? Qt.darker(Theme.warning, 1.10) : Theme.warning
                }

                contentItem: Text {
                    text: parent.text
                    color: "#101318"
                    font.pixelSize: Theme.fontBody
                    font.weight: Font.DemiBold
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }

                onClicked: {
                    root.close()
                    root.confirmed()
                }
            }
        }
    }
}
