import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    required property var api
    required property var desktop
    property string languageToken: i18n.language
    property string errorText: ""

    Layout.fillWidth: true
    implicitHeight: contentColumn.implicitHeight + 28
    radius: Theme.radiusMedium
    color: Theme.surface
    border.color: Theme.border

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function healthValue(key, fallback) {
        const health = api.browserIntegrationHealth || ({})
        const value = health[key]
        return value === undefined || value === null || value === "" ? fallback : value
    }

    function statusText() {
        if (!api.connected)
            return root.t("browser.daemonOffline")

        const health = api.browserIntegrationHealth || ({})
        if (health.status === "connected")
            return root.t("browser.connected")
        if (health.status === "degraded")
            return root.t("browser.degraded")
        if (health.status === "disconnected")
            return root.t("browser.disconnected")
        return root.t("browser.unknown")
    }

    function statusColor() {
        const health = api.browserIntegrationHealth || ({})
        if (!api.connected)
            return Theme.warning
        if (health.status === "connected")
            return Theme.success
        if (health.status === "degraded")
            return Theme.warning
        return Theme.textMuted
    }

    function yesNo(value) {
        return value ? root.t("common.yes") : root.t("common.no")
    }

    Component.onCompleted: api.refreshBrowserIntegration()

    Connections {
        target: root.api

        function onBrowserIntegrationChanged() {
            if (Object.keys(root.api.browserIntegrationHealth || ({})).length > 0)
                root.errorText = ""
        }

        function onBrowserIntegrationFailed(message) {
            root.errorText = message
        }
    }

    ColumnLayout {
        id: contentColumn
        anchors.fill: parent
        anchors.margins: 14
        spacing: 10

        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            Rectangle {
                width: 9
                height: 9
                radius: 5
                color: root.statusColor()
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2

                Text {
                    text: root.t("browser.title")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontBody
                    font.weight: Font.DemiBold
                }

                Text {
                    text: root.statusText()
                    color: root.statusColor()
                    font.pixelSize: Theme.fontSmall
                    font.weight: Font.DemiBold
                }
            }

            Button {
                text: root.api.browserIntegrationBusy
                    ? root.t("browser.checking")
                    : root.t("action.refresh")
                enabled: root.api.connected && !root.api.browserIntegrationBusy
                Accessible.name: text
                onClicked: root.api.refreshBrowserIntegration()
            }
        }

        GridLayout {
            Layout.fillWidth: true
            columns: 4
            columnSpacing: 16
            rowSpacing: 6

            Text {
                text: root.t("browser.enabled")
                color: Theme.textMuted
                font.pixelSize: Theme.fontTiny
            }
            Text {
                text: root.yesNo(Boolean(root.healthValue("enabled", false)))
                color: Theme.textPrimary
                font.pixelSize: Theme.fontSmall
                font.weight: Font.DemiBold
            }
            Text {
                text: root.t("browser.paired")
                color: Theme.textMuted
                font.pixelSize: Theme.fontTiny
            }
            Text {
                text: root.yesNo(Boolean(root.healthValue("paired", false)))
                color: Boolean(root.healthValue("paired", false)) ? Theme.success : Theme.warning
                font.pixelSize: Theme.fontSmall
                font.weight: Font.DemiBold
            }

            Text {
                text: root.t("browser.version")
                color: Theme.textMuted
                font.pixelSize: Theme.fontTiny
            }
            Text {
                text: String(root.healthValue("version", root.t("common.unknown")))
                color: Theme.textPrimary
                font.pixelSize: Theme.fontSmall
            }
            Text {
                text: root.t("browser.captureEndpoint")
                color: Theme.textMuted
                font.pixelSize: Theme.fontTiny
            }
            Text {
                text: String(root.healthValue("captureEndpoint", root.t("common.unknown")))
                color: Theme.textPrimary
                font.pixelSize: Theme.fontSmall
                font.family: "monospace"
            }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: capabilityColumn.implicitHeight + 18
            radius: Theme.radiusSmall
            color: Theme.surfaceRaised
            border.color: Theme.border

            ColumnLayout {
                id: capabilityColumn
                anchors.fill: parent
                anchors.margins: 9
                spacing: 7

                Text {
                    text: root.t("browser.capabilities")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontSmall
                    font.weight: Font.DemiBold
                }

                RowLayout {
                    Layout.fillWidth: true

                    Text {
                        Layout.fillWidth: true
                        text: root.t("browser.directDownloads")
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontTiny
                    }
                    Text {
                        text: root.yesNo(Boolean(root.healthValue("directDownloads", false)))
                        color: Boolean(root.healthValue("directDownloads", false))
                            ? Theme.success : Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                        font.weight: Font.Bold
                    }

                    Text {
                        Layout.fillWidth: true
                        text: root.t("browser.mediaDownloads")
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontTiny
                    }
                    Text {
                        text: root.yesNo(Boolean(root.healthValue("mediaDownloads", false)))
                        color: Boolean(root.healthValue("mediaDownloads", false))
                            ? Theme.success : Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                        font.weight: Font.Bold
                    }

                    Text {
                        Layout.fillWidth: true
                        text: root.t("browser.postProcessing")
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontTiny
                    }
                    Text {
                        text: root.yesNo(Boolean(root.healthValue("postProcessing", false)))
                        color: Boolean(root.healthValue("postProcessing", false))
                            ? Theme.success : Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                        font.weight: Font.Bold
                    }
                }
            }
        }

        Text {
            Layout.fillWidth: true
            text: Boolean(root.healthValue("paired", false))
                ? root.t("browser.zeroClickReady")
                : root.t("browser.zeroClickHelp")
            color: Boolean(root.healthValue("paired", false))
                ? Theme.textSecondary : Theme.warning
            font.pixelSize: Theme.fontTiny
            wrapMode: Text.WordWrap
        }

        Text {
            Layout.fillWidth: true
            visible: root.errorText.length > 0
            text: root.errorText
            color: Theme.danger
            font.pixelSize: Theme.fontTiny
            wrapMode: Text.WordWrap
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Button {
                text: root.t("browser.getExtension")
                Accessible.name: text
                onClicked: root.desktop.openExternalUrl(
                    "https://github.com/Alaa91H/NOVADownloadManager/releases/latest"
                )
            }

            Button {
                text: root.t("browser.setupGuide")
                flat: true
                Accessible.name: text
                onClicked: root.desktop.openExternalUrl(
                    "https://github.com/Alaa91H/NOVADownloadManager/blob/main/docs/extension/ZERO_CLICK_PAIRING.md"
                )
            }

            Item { Layout.fillWidth: true }

            Text {
                text: root.t("browser.tokenProtected")
                color: Theme.textMuted
                font.pixelSize: Theme.fontTiny
            }
        }
    }
}
