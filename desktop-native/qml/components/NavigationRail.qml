import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    property string currentPage: "downloads"
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }
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
                    font.pixelSize: Math.round(15 * Theme.fontScale)
                    font.weight: Font.Bold
                }
            }

            ColumnLayout {
                spacing: 0
                Text {
                    text: "NOVA"
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontMedium
                    font.weight: Font.DemiBold
                }
                Text {
                    text: root.t("app.name").replace("NOVA ", "")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontSmall
                }
            }
        }

        Text {
            Layout.leftMargin: 10
            Layout.topMargin: 2
            Layout.bottomMargin: 3
            text: root.t("nav.library")
            color: Theme.textMuted
            font.pixelSize: Theme.fontTiny
            font.weight: Font.DemiBold
            font.letterSpacing: 0.8
        }

        Repeater {
            model: [
                { page: "downloads", label: root.t("nav.downloads"), badge: "" },
                { page: "active", label: root.t("nav.active"), badge: root.activeDownloads > 0 ? String(root.activeDownloads) : "" },
                { page: "queued", label: root.t("nav.queued"), badge: "" },
                { page: "completed", label: root.t("nav.completed"), badge: "" },
                { page: "failed", label: root.t("nav.failed"), badge: "" }
            ]

            delegate: Button {
                required property var modelData

                Layout.fillWidth: true
                Layout.preferredHeight: 34
                flat: true
                hoverEnabled: true
                activeFocusOnTab: true
                Accessible.name: modelData.label
                Accessible.description: modelData.page === root.currentPage
                    ? modelData.label + " — selected"
                    : modelData.label

                background: Rectangle {
                    radius: Theme.radiusMedium
                    border.width: parent.activeFocus ? 2 : 0
                    border.color: Theme.focusRing
                    color: modelData.page === root.currentPage
                        ? Theme.surfaceSelected
                        : parent.hovered ? Theme.surfaceHover : "transparent"
                }

                contentItem: RowLayout {
                    spacing: 8

                    Text {
                        text: modelData.label
                        color: modelData.page === root.currentPage ? Theme.textPrimary : Theme.textSecondary
                        font.pixelSize: Theme.fontBody
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
                            font.pixelSize: Theme.fontSmall
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
            text: root.t("nav.tools")
            color: Theme.textMuted
            font.pixelSize: Theme.fontTiny
            font.weight: Font.DemiBold
            font.letterSpacing: 0.8
        }

        Repeater {
            model: [
                { page: "queue", label: root.t("nav.queue") },
                { page: "batch", label: root.t("nav.batch") },
                { page: "scheduler", label: root.t("nav.scheduler") },
                { page: "media", label: root.t("nav.media") },
                { page: "grabber", label: root.t("nav.grabber") }
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
                    font.pixelSize: Theme.fontBody
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
            activeFocusOnTab: true
            Accessible.name: root.t("nav.settings")

            background: Rectangle {
                radius: Theme.radiusMedium
                border.width: parent.activeFocus ? 2 : 0
                border.color: Theme.focusRing
                color: root.currentPage === "settings"
                    ? Theme.surfaceSelected
                    : parent.hovered ? Theme.surfaceHover : "transparent"
            }

            contentItem: Text {
                text: root.t("nav.settings")
                color: root.currentPage === "settings" ? Theme.textPrimary : Theme.textSecondary
                font.pixelSize: Theme.fontBody
                font.weight: root.currentPage === "settings" ? Font.DemiBold : Font.Normal
                verticalAlignment: Text.AlignVCenter
            }

            onClicked: root.pageSelected("settings")
        }
    }
}
