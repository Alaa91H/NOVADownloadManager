import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    required property var settings
    property string languageToken: i18n.language
    signal closeRequested()
    signal openSettingsRequested()

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    implicitWidth: Theme.customizationWidth
    color: Theme.surfaceRaised
    border.color: Theme.border
    radius: Theme.radiusLarge
    clip: true

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Layout.preferredHeight: 54
            Layout.leftMargin: 14
            Layout.rightMargin: 8
            spacing: 8

            Text {
                Layout.fillWidth: true
                text: root.t("custom.title")
                color: Theme.textPrimary
                font.pixelSize: Theme.fontMedium
                font.weight: Font.DemiBold
            }

            ToolButton {
                text: "×"
                Accessible.name: root.t("common.close")
                onClicked: root.closeRequested()
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 1
            color: Theme.border
        }

        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true

            ColumnLayout {
                width: parent.availableWidth
                spacing: 16
                leftPadding: 14
                rightPadding: 14
                topPadding: 14
                bottomPadding: 14

                Text {
                    text: root.t("settings.theme")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                    font.weight: Font.DemiBold
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    Repeater {
                        model: [
                            { value: "light", icon: "☀", label: root.t("settings.light") },
                            { value: "dark", icon: "☾", label: root.t("settings.dark") },
                            { value: "system", icon: "▣", label: root.t("settings.system") }
                        ]

                        delegate: Button {
                            required property var modelData
                            Layout.fillWidth: true
                            Layout.preferredHeight: 74
                            checkable: true
                            checked: root.settings.appearanceMode === modelData.value
                            Accessible.name: modelData.label
                            onClicked: root.settings.appearanceMode = modelData.value

                            background: Rectangle {
                                radius: Theme.radiusMedium
                                color: parent.checked ? Theme.surfaceSelected : Theme.surface
                                border.width: parent.checked ? 2 : 1
                                border.color: parent.checked ? Theme.accent : Theme.border
                            }

                            contentItem: ColumnLayout {
                                spacing: 4

                                Text {
                                    Layout.alignment: Qt.AlignHCenter
                                    text: modelData.icon
                                    color: parent.parent.checked ? Theme.accent : Theme.textSecondary
                                    font.pixelSize: Theme.fontMedium
                                }

                                Text {
                                    Layout.alignment: Qt.AlignHCenter
                                    text: modelData.label
                                    color: Theme.textPrimary
                                    font.pixelSize: Theme.fontSmall
                                }
                            }
                        }
                    }
                }

                Text {
                    Layout.topMargin: 2
                    text: root.t("custom.accent")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                    font.weight: Font.DemiBold
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    Repeater {
                        model: [
                            "#168df7", "#7c5cff", "#e93d82",
                            "#dc2626", "#c86700", "#168a4a"
                        ]

                        delegate: Button {
                            required property string modelData
                            Layout.preferredWidth: 32
                            Layout.preferredHeight: 32
                            Accessible.name: root.t("custom.accent") + " " + modelData
                            onClicked: root.settings.accentColor = modelData

                            background: Rectangle {
                                anchors.centerIn: parent
                                width: 24
                                height: 24
                                radius: 12
                                color: modelData
                                border.width: root.settings.accentColor.toLowerCase() === modelData ? 3 : 1
                                border.color: root.settings.accentColor.toLowerCase() === modelData
                                    ? Theme.textPrimary : Theme.borderStrong
                            }

                            contentItem: Item {}
                        }
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 1
                    color: Theme.border
                }

                Text {
                    text: root.t("custom.density")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                    font.weight: Font.DemiBold
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 5

                    Repeater {
                        model: [
                            { value: "comfortable", label: root.t("custom.comfortable"), glyph: "●" },
                            { value: "compact", label: root.t("custom.compact"), glyph: "≡" },
                            { value: "dense", label: root.t("custom.dense"), glyph: "☷" }
                        ]

                        delegate: Button {
                            required property var modelData
                            Layout.fillWidth: true
                            Layout.preferredHeight: 38
                            checked: root.settings.interfaceDensity === modelData.value
                            Accessible.name: modelData.label
                            onClicked: root.settings.interfaceDensity = modelData.value

                            background: Rectangle {
                                radius: Theme.radiusMedium
                                color: parent.checked ? Theme.surfaceSelected : Theme.surface
                                border.width: parent.checked ? 1 : 0
                                border.color: Theme.accent
                            }

                            contentItem: RowLayout {
                                spacing: 8

                                Text {
                                    text: modelData.glyph
                                    color: parent.parent.checked ? Theme.accent : Theme.textMuted
                                    font.pixelSize: Theme.fontBody
                                }
                                Text {
                                    Layout.fillWidth: true
                                    text: modelData.label
                                    color: Theme.textPrimary
                                    font.pixelSize: Theme.fontBody
                                }
                                Text {
                                    visible: parent.parent.checked
                                    text: "●"
                                    color: Theme.accent
                                    font.pixelSize: Theme.fontSmall
                                }
                            }
                        }
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 1
                    color: Theme.border
                }

                Switch {
                    Layout.fillWidth: true
                    text: root.t("custom.showSidebar")
                    checked: root.settings.sidebarVisible
                    Accessible.name: text
                    onToggled: root.settings.sidebarVisible = checked
                }

                Switch {
                    Layout.fillWidth: true
                    text: root.t("custom.compactSidebar")
                    checked: root.settings.sidebarCollapsed
                    enabled: root.settings.sidebarVisible
                    Accessible.name: text
                    onToggled: root.settings.sidebarCollapsed = checked
                }

                Switch {
                    Layout.fillWidth: true
                    text: root.t("custom.showDetails")
                    checked: root.settings.detailsPanelVisible
                    Accessible.name: text
                    onToggled: root.settings.detailsPanelVisible = checked
                }

                Switch {
                    Layout.fillWidth: true
                    text: root.t("custom.showStatus")
                    checked: root.settings.statusBarVisible
                    Accessible.name: text
                    onToggled: root.settings.statusBarVisible = checked
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 1
                    color: Theme.border
                }

                RowLayout {
                    Layout.fillWidth: true

                    Text {
                        Layout.fillWidth: true
                        text: root.t("custom.cornerRadius")
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.DemiBold
                    }

                    Rectangle {
                        implicitWidth: radiusValue.implicitWidth + 16
                        implicitHeight: 26
                        radius: Theme.radiusMedium
                        color: Theme.surface

                        Text {
                            id: radiusValue
                            anchors.centerIn: parent
                            text: String(root.settings.cornerRadius)
                            color: Theme.textSecondary
                            font.pixelSize: Theme.fontSmall
                            font.family: "monospace"
                        }
                    }
                }

                Slider {
                    Layout.fillWidth: true
                    from: 4
                    to: 18
                    stepSize: 1
                    value: root.settings.cornerRadius
                    Accessible.name: root.t("custom.cornerRadius")
                    onMoved: root.settings.cornerRadius = Math.round(value)
                }

                Item { Layout.preferredHeight: 2 }

                Button {
                    Layout.fillWidth: true
                    text: root.t("custom.moreSettings")
                    Accessible.name: text
                    onClicked: root.openSettingsRequested()
                }
            }
        }
    }
}
