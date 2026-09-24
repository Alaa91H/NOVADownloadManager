import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    property string currentPage: "downloads"
    property int activeDownloads: 0
    signal pageSelected(string page)

    implicitWidth: Theme.navigationWidth
    color: Theme.sidebar

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 10
        spacing: 4

        RowLayout {
            Layout.fillWidth: true
            Layout.leftMargin: 6
            Layout.rightMargin: 6
            Layout.topMargin: 5
            Layout.bottomMargin: 14
            spacing: 10

            Rectangle {
                width: 28
                height: 28
                radius: 7
                color: Theme.accent

                Text {
                    anchors.centerIn: parent
                    text: "N"
                    color: "white"
                    font.pixelSize: 15
                    font.weight: Font.Bold
                }
            }

            ColumnLayout {
                spacing: 0
                Text {
                    text: "NOVA"
                    color: Theme.textPrimary
                    font.pixelSize: 14
                    font.weight: Font.DemiBold
                }
                Text {
                    text: "Download Manager"
                    color: Theme.textMuted
                    font.pixelSize: 10
                }
            }
        }

        Text {
            Layout.leftMargin: 10
            Layout.topMargin: 2
            Layout.bottomMargin: 3
            text: "LIBRARY"
            color: Theme.textMuted
            font.pixelSize: 9
            font.weight: Font.DemiBold
            font.letterSpacing: 0.8
        }

        Repeater {
            model: [
                { page: "downloads", label: "Downloads", badge: "" },
                { page: "active", label: "Active", badge: root.activeDownloads > 0 ? String(root.activeDownloads) : "" },
                { page: "queued", label: "Queued", badge: "" },
                { page: "completed", label: "Completed", badge: "" },
                { page: "failed", label: "Failed", badge: "" }
            ]

            delegate: Button {
                required property var modelData

                Layout.fillWidth: true
                Layout.preferredHeight: 34
                flat: true
                hoverEnabled: true

                background: Rectangle {
                    radius: Theme.radiusMedium
                    color: modelData.page === root.currentPage
                        ? Theme.surfaceSelected
                        : parent.hovered ? Theme.surfaceHover : "transparent"
                }

                contentItem: RowLayout {
                    spacing: 8

                    Text {
                        text: modelData.label
                        color: modelData.page === root.currentPage ? Theme.textPrimary : Theme.textSecondary
                        font.pixelSize: 12
                        font.weight: modelData.page === root.currentPage ? Font.DemiBold : Font.Normal
                    }

                    Item { Layout.fillWidth: true }

                    Rectangle {
                        visible: modelData.badge !== ""
                        implicitWidth: Math.max(22, badgeText.implicitWidth + 10)
                        implicitHeight: 18
                        radius: 9
                        color: Theme.surface

                        Text {
                            id: badgeText
                            anchors.centerIn: parent
                            text: modelData.badge
                            color: Theme.textSecondary
                            font.pixelSize: 10
                        }
                    }
                }

                onClicked: root.pageSelected(modelData.page)
            }
        }

        Text {
            Layout.leftMargin: 10
            Layout.topMargin: 14
            Layout.bottomMargin: 3
            text: "TOOLS"
            color: Theme.textMuted
            font.pixelSize: 9
            font.weight: Font.DemiBold
            font.letterSpacing: 0.8
        }

        Repeater {
            model: [
                { page: "queue", label: "Queue Manager" },
                { page: "batch", label: "Batch Import" },
                { page: "scheduler", label: "Scheduler" },
                { page: "media", label: "Media Downloader" },
                { page: "grabber", label: "Link Grabber" }
            ]

            delegate: Button {
                required property var modelData

                Layout.fillWidth: true
                Layout.preferredHeight: 34
                flat: true
                hoverEnabled: true

                background: Rectangle {
                    radius: Theme.radiusMedium
                    color: modelData.page === root.currentPage
                        ? Theme.surfaceSelected
                        : parent.hovered ? Theme.surfaceHover : "transparent"
                }

                contentItem: Text {
                    text: modelData.label
                    color: modelData.page === root.currentPage ? Theme.textPrimary : Theme.textSecondary
                    font.pixelSize: 12
                    font.weight: modelData.page === root.currentPage ? Font.DemiBold : Font.Normal
                    verticalAlignment: Text.AlignVCenter
                }

                onClicked: root.pageSelected(modelData.page)
            }
        }

        Item { Layout.fillHeight: true }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 1
            color: Theme.border
        }

        Button {
            Layout.fillWidth: true
            Layout.preferredHeight: 36
            flat: true
            hoverEnabled: true

            background: Rectangle {
                radius: Theme.radiusMedium
                color: root.currentPage === "settings"
                    ? Theme.surfaceSelected
                    : parent.hovered ? Theme.surfaceHover : "transparent"
            }

            contentItem: Text {
                text: "Settings"
                color: root.currentPage === "settings" ? Theme.textPrimary : Theme.textSecondary
                font.pixelSize: 12
                font.weight: root.currentPage === "settings" ? Font.DemiBold : Font.Normal
                verticalAlignment: Text.AlignVCenter
            }

            onClicked: root.pageSelected("settings")
        }
    }
}
