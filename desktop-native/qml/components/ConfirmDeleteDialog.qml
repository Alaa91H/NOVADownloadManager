import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Dialog {
    id: root

    property string downloadName: ""
    property string languageToken: i18n.language
    signal confirmed()

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    modal: true
    focus: true
    closePolicy: Popup.CloseOnEscape
    width: Math.min(430, parent ? parent.width - 48 : 430)
    title: root.t("delete.title")

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
            text: root.t("delete.question")
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
            text: root.t("delete.detail")
            color: Theme.textMuted
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.WordWrap
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 6

            Item { Layout.fillWidth: true }

            Button {
                text: root.t("common.cancel")
                onClicked: root.close()
            }

            Button {
                text: root.t("action.delete")

                background: Rectangle {
                    radius: Theme.radiusMedium
                    color: parent.pressed ? Qt.darker(Theme.danger, 1.10) : Theme.danger
                }

                contentItem: Text {
                    text: parent.text
                    color: "white"
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
