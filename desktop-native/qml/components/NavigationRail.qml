import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    property string currentPage: "downloads"
    property string languageToken: i18n.language
    property int activeDownloads: 0
    property bool collapsed: true
    signal pageSelected(string page)

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    implicitWidth: collapsed
        ? Theme.navigationCollapsedWidth
        : Theme.navigationExpandedWidth
    color: Theme.sidebar

    Behavior on implicitWidth {
        NumberAnimation { duration: Theme.animationNormal; easing.type: Easing.OutCubic }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: collapsed ? 8 : 10
        spacing: 5

        ToolButton {
            Layout.fillWidth: true
            Layout.preferredHeight: 38
            text: root.collapsed ? "⇥" : "⇤"
            Accessible.name: root.t("custom.compactSidebar")
            ToolTip.visible: hovered
            ToolTip.text: root.t("custom.compactSidebar")
            onClicked: nativeSettings.sidebarCollapsed = !nativeSettings.sidebarCollapsed
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 1
            Layout.topMargin: 2
            Layout.bottomMargin: 2
            color: Theme.border
        }

        Repeater {
            model: [
                { page: "downloads", glyph: "↓", label: root.t("nav.downloads"), badge: "" },
                { page: "active", glyph: "≋", label: root.t("nav.active"), badge: root.activeDownloads > 0 ? String(root.activeDownloads) : "" },
                { page: "queued", glyph: "☷", label: root.t("nav.queued"), badge: "" },
                { page: "completed", glyph: "✓", label: root.t("nav.completed"), badge: "" },
                { page: "failed", glyph: "×", label: root.t("nav.failed"), badge: "" }
            ]

            delegate: Button {
                required property var modelData
                Layout.fillWidth: true
                Layout.preferredHeight: 46
                flat: true
                hoverEnabled: true
                activeFocusOnTab: true
                Accessible.name: modelData.label
                ToolTip.visible: root.collapsed && hovered
                ToolTip.text: modelData.label

                background: Rectangle {
                    radius: Theme.radiusMedium
                    border.width: parent.activeFocus ? 2 : 0
                    border.color: Theme.focusRing
                    color: modelData.page === root.currentPage
                        ? Theme.accentMuted
                        : parent.hovered ? Theme.surfaceHover : "transparent"
                }

                contentItem: RowLayout {
                    spacing: 10

                    Item {
                        Layout.preferredWidth: root.collapsed ? 30 : 32
                        Layout.preferredHeight: 30

                        Text {
                            anchors.centerIn: parent
                            text: modelData.glyph
                            color: modelData.page === root.currentPage
                                ? Theme.accent : Theme.textSecondary
                            font.pixelSize: Theme.fontMedium
                            font.weight: Font.DemiBold
                        }

                        Rectangle {
                            visible: root.collapsed && modelData.badge !== ""
                            anchors.right: parent.right
                            anchors.top: parent.top
                            implicitWidth: Math.max(15, badgeText.implicitWidth + 6)
                            implicitHeight: 15
                            radius: 8
                            color: Theme.accent

                            Text {
                                id: badgeText
                                anchors.centerIn: parent
                                text: modelData.badge
                                color: "white"
                                font.pixelSize: Theme.fontTiny
                                font.weight: Font.DemiBold
                            }
                        }
                    }

                    Text {
                        visible: !root.collapsed
                        Layout.fillWidth: true
                        text: modelData.label
                        color: modelData.page === root.currentPage
                            ? Theme.textPrimary : Theme.textSecondary
                        font.pixelSize: Theme.fontBody
                        font.weight: modelData.page === root.currentPage
                            ? Font.DemiBold : Font.Normal
                        elide: Text.ElideRight
                    }

                    Rectangle {
                        visible: !root.collapsed && modelData.badge !== ""
                        implicitWidth: Math.max(22, expandedBadge.implicitWidth + 10)
                        implicitHeight: 18
                        radius: 9
                        color: Theme.surface

                        Text {
                            id: expandedBadge
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

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 1
            Layout.topMargin: 5
            Layout.bottomMargin: 2
            color: Theme.border
        }

        Repeater {
            model: [
                { page: "queue", glyph: "☷", label: root.t("nav.queue") },
                { page: "batch", glyph: "⊞", label: root.t("nav.batch") },
                { page: "scheduler", glyph: "◷", label: root.t("nav.scheduler") },
                { page: "media", glyph: "▷", label: root.t("nav.media") },
                { page: "grabber", glyph: "◎", label: root.t("nav.grabber") }
            ]

            delegate: Button {
                required property var modelData
                Layout.fillWidth: true
                Layout.preferredHeight: 42
                flat: true
                hoverEnabled: true
                activeFocusOnTab: true
                Accessible.name: modelData.label
                ToolTip.visible: root.collapsed && hovered
                ToolTip.text: modelData.label

                background: Rectangle {
                    radius: Theme.radiusMedium
                    border.width: parent.activeFocus ? 2 : 0
                    border.color: Theme.focusRing
                    color: modelData.page === root.currentPage
                        ? Theme.accentMuted
                        : parent.hovered ? Theme.surfaceHover : "transparent"
                }

                contentItem: RowLayout {
                    spacing: 10

                    Text {
                        Layout.preferredWidth: root.collapsed ? 30 : 32
                        horizontalAlignment: Text.AlignHCenter
                        text: modelData.glyph
                        color: modelData.page === root.currentPage
                            ? Theme.accent : Theme.textSecondary
                        font.pixelSize: Theme.fontMedium
                    }

                    Text {
                        visible: !root.collapsed
                        Layout.fillWidth: true
                        text: modelData.label
                        color: modelData.page === root.currentPage
                            ? Theme.textPrimary : Theme.textSecondary
                        font.pixelSize: Theme.fontBody
                        font.weight: modelData.page === root.currentPage
                            ? Font.DemiBold : Font.Normal
                        elide: Text.ElideRight
                    }
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
            Layout.preferredHeight: 44
            flat: true
            hoverEnabled: true
            activeFocusOnTab: true
            Accessible.name: root.t("nav.settings")
            ToolTip.visible: root.collapsed && hovered
            ToolTip.text: root.t("nav.settings")

            background: Rectangle {
                radius: Theme.radiusMedium
                border.width: parent.activeFocus ? 2 : 0
                border.color: Theme.focusRing
                color: root.currentPage === "settings"
                    ? Theme.accentMuted
                    : parent.hovered ? Theme.surfaceHover : "transparent"
            }

            contentItem: RowLayout {
                spacing: 10

                Text {
                    Layout.preferredWidth: root.collapsed ? 30 : 32
                    horizontalAlignment: Text.AlignHCenter
                    text: "⚙"
                    color: root.currentPage === "settings"
                        ? Theme.accent : Theme.textSecondary
                    font.pixelSize: Theme.fontMedium
                }

                Text {
                    visible: !root.collapsed
                    Layout.fillWidth: true
                    text: root.t("nav.settings")
                    color: root.currentPage === "settings"
                        ? Theme.textPrimary : Theme.textSecondary
                    font.pixelSize: Theme.fontBody
                    font.weight: root.currentPage === "settings"
                        ? Font.DemiBold : Font.Normal
                }
            }

            onClicked: root.pageSelected("settings")
        }
    }
}
