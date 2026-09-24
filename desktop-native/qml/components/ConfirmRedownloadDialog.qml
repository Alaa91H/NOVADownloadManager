import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Dialog {
    id: root

    property string downloadName: ""
    property bool retryMode: false
    signal confirmed()

    modal: true
    focus: true
    closePolicy: Popup.CloseOnEscape
    width: Math.min(460, parent ? parent.width - 48 : 460)
    title: retryMode ? "Retry download" : "Redownload from beginning"

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
                ? "Retry this download from the beginning?"
                : "Download this file again from the beginning?"
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
            text: "NOVA will reset progress, clear stale resume data and replace the existing output for this task."
            color: Theme.warning
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
                text: root.retryMode ? "Retry" : "Redownload"

                background: Rectangle {
                    radius: Theme.radiusMedium
                    color: parent.pressed ? Qt.darker(Theme.warning, 1.10) : Theme.warning
                }

                contentItem: Text {
                    text: parent.text
                    color: "#101318"
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
