import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Dialog {
    id: root

    property string downloadName: ""
    signal confirmed()

    modal: true
    focus: true
    closePolicy: Popup.CloseOnEscape
    width: Math.min(430, parent ? parent.width - 48 : 430)
    title: "Delete download"

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
            text: "Remove this download from NOVA?"
            color: Theme.textPrimary
            font.pixelSize: 16
            font.weight: Font.DemiBold
            wrapMode: Text.WordWrap
        }

        Text {
            Layout.fillWidth: true
            text: root.downloadName.length > 0 ? root.downloadName : "Selected download"
            color: Theme.textSecondary
            font.pixelSize: 11
            wrapMode: Text.WrapAnywhere
        }

        Text {
            Layout.fillWidth: true
            text: "This removes the selected task from the download manager."
            color: Theme.textMuted
            font.pixelSize: 10
            wrapMode: Text.WordWrap
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 6

            Item { Layout.fillWidth: true }

            Button {
                text: "Cancel"
                onClicked: root.close()
            }

            Button {
                text: "Delete"

                background: Rectangle {
                    radius: Theme.radiusMedium
                    color: parent.pressed ? Qt.darker(Theme.danger, 1.10) : Theme.danger
                }

                contentItem: Text {
                    text: parent.text
                    color: "white"
                    font.pixelSize: 12
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
