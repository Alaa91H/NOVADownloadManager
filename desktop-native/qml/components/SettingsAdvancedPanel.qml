import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

ScrollView {
    id: root

    required property var api
    required property var settings
    required property var desktop

    property string noticeText: ""
    property bool noticeError: false
    property string languageToken: i18n.language
    property bool resetArmed: false

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function advanced(key, fallback) {
        const value = settings.advancedSettings[key]
        return value === undefined || value === null ? fallback : value
    }

    function setAdvanced(key, value) {
        settings.setAdvancedValue(key, value)
    }

    function shortcut(key) {
        return String(settings.shortcutBindings[key] || "")
    }

    function externalToolName(tool) {
        return tool.name || tool.toolName || tool.toolId || tool.id || root.t("settings.unknownTool")
    }

    function externalToolId(tool) {
        return String(tool.toolId || tool.id || "")
    }

    function externalToolStatus(tool) {
        return String(tool.status || tool.installationStatus || root.t("settings.unknown"))
    }

    function showNotice(message, error) {
        noticeText = message
        noticeError = error
        noticeTimer.restart()
    }

    Component.onCompleted: api.refreshSettingsServices()

    Connections {
        target: api

        function onSettingsServiceActionCompleted(action, message) {
            if (action === "dns")
                root.showNotice(root.t("settings.dnsComplete"), false)
            else if (action === "telegram-test")
                root.showNotice(root.t("settings.telegramTestOk"), false)
            else if (action === "telegram")
                root.showNotice(root.t("settings.telegramSaved"), false)
            else if (action === "external-tool")
                root.showNotice(root.t("settings.externalToolUpdated") + " " + message, false)
        }

        function onRequestFailed(message) {
            if (root.visible)
                root.showNotice(message, true)
        }
    }

    Timer {
        id: noticeTimer
        interval: 5000
        onTriggered: root.noticeText = ""
    }

    ColumnLayout {
        width: root.availableWidth
        spacing: 12

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: noticeTextItem.implicitHeight + 18
            visible: root.noticeText.length > 0
            radius: Theme.radiusMedium
            color: Theme.surfaceRaised
            border.color: root.noticeError ? Theme.danger : Theme.success

            Text {
                id: noticeTextItem
                anchors.fill: parent
                anchors.margins: 9
                text: root.noticeText
                color: root.noticeError ? Theme.danger : Theme.success
                font.pixelSize: Theme.fontSmall
                wrapMode: Text.WordWrap
            }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: networkColumn.implicitHeight + 28
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            ColumnLayout {
                id: networkColumn
                anchors.fill: parent
                anchors.margins: 14
                spacing: 10

                Text {
                    text: root.t("settings.networkPerformance")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontBody
                    font.weight: Font.DemiBold
                }

                RowLayout {
                    Layout.fillWidth: true

                    Switch {
                        id: speedLimiterSwitch
                        text: root.t("settings.speedLimiter")
                        checked: Boolean(root.advanced("speedLimiterEnabled", false))
                        onToggled: {
                            root.setAdvanced("speedLimiterEnabled", checked)
                            api.setGlobalBandwidthLimit(
                                checked ? speedLimitSpin.value : 0
                            )
                        }
                    }

                    SpinBox {
                        id: speedLimitSpin
                        from: 0
                        to: 100000000
                        editable: true
                        value: Number(root.advanced("speedLimitKbs", 0))
                        enabled: speedLimiterSwitch.checked
                        onValueModified: {
                            root.setAdvanced("speedLimitKbs", value)
                            if (speedLimiterSwitch.checked)
                                api.setGlobalBandwidthLimit(value)
                        }
                    }

                    Text {
                        text: "KB/s"
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                    }

                    Item { Layout.fillWidth: true }
                }

                Switch {
                    text: root.t("settings.enableProxy")
                    checked: Boolean(root.advanced("proxyEnabled", false))
                    onToggled: root.setAdvanced("proxyEnabled", checked)
                }

                RowLayout {
                    Layout.fillWidth: true
                    enabled: Boolean(root.advanced("proxyEnabled", false))

                    Text { text: root.t("settings.proxyType"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                    ComboBox {
                        model: ["http", "https", "socks4", "socks4a", "socks5", "socks5h"]
                        currentIndex: Math.max(0, model.indexOf(String(root.advanced("proxyType", "http"))))
                        onActivated: root.setAdvanced("proxyType", currentText)
                    }
                    Switch {
                        text: root.t("settings.proxyTunnel")
                        checked: Boolean(root.advanced("proxyTunnel", false))
                        onToggled: root.setAdvanced("proxyTunnel", checked)
                    }
                    Item { Layout.fillWidth: true }
                }

                GridLayout {
                    Layout.fillWidth: true
                    columns: 2
                    columnSpacing: 10
                    rowSpacing: 8

                    TextField {
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.proxyHost")
                        text: String(root.advanced("proxyHost", ""))
                        enabled: Boolean(root.advanced("proxyEnabled", false))
                        onEditingFinished: root.setAdvanced("proxyHost", text)
                    }

                    TextField {
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.proxyPort")
                        text: String(root.advanced("proxyPort", ""))
                        enabled: Boolean(root.advanced("proxyEnabled", false))
                        inputMethodHints: Qt.ImhDigitsOnly
                        onEditingFinished: root.setAdvanced("proxyPort", text)
                    }

                    TextField {
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.proxyUser")
                        text: String(root.advanced("proxyUser", ""))
                        enabled: Boolean(root.advanced("proxyEnabled", false))
                        onEditingFinished: root.setAdvanced("proxyUser", text)
                    }

                    TextField {
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.proxyPassword")
                        text: String(root.advanced("proxyPassword", ""))
                        enabled: Boolean(root.advanced("proxyEnabled", false))
                        echoMode: TextInput.Password
                        onEditingFinished: root.setAdvanced("proxyPassword", text)
                    }
                }

                RowLayout {
                    Layout.fillWidth: true

                    Text { text: root.t("settings.timeout"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                    SpinBox {
                        from: 1; to: 86400
                        value: Number(root.advanced("timeoutSec", 60))
                        onValueModified: root.setAdvanced("timeoutSec", value)
                    }
                    Text { text: root.t("settings.connectTimeout"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                    SpinBox {
                        from: 1; to: 3600
                        value: Number(root.advanced("connectTimeoutSec", 30))
                        onValueModified: root.setAdvanced("connectTimeoutSec", value)
                    }
                    Text { text: root.t("settings.maxRedirects"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                    SpinBox {
                        from: 0; to: 1000
                        value: Number(root.advanced("maxRedirs", 20))
                        onValueModified: root.setAdvanced("maxRedirs", value)
                    }
                    Item { Layout.fillWidth: true }
                }

                RowLayout {
                    Layout.fillWidth: true

                    Text { text: root.t("settings.retryCount"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                    SpinBox {
                        from: 0; to: 9999
                        value: Number(root.advanced("retryCount", 3))
                        onValueModified: root.setAdvanced("retryCount", value)
                    }
                    Text { text: root.t("settings.retryDelay"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                    SpinBox {
                        from: 1; to: 86400
                        value: Number(root.advanced("retryDelaySec", 5))
                        onValueModified: root.setAdvanced("retryDelaySec", value)
                    }
                    Switch {
                        text: root.t("settings.dynamicAllocation")
                        checked: Boolean(root.advanced("dynamicAllocation", true))
                        onToggled: root.setAdvanced("dynamicAllocation", checked)
                    }
                    Text { text: root.t("settings.bufferKb"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                    SpinBox {
                        from: 16; to: 1048576
                        value: Number(root.advanced("bufferSizeKb", 256))
                        onValueModified: root.setAdvanced("bufferSizeKb", value)
                    }
                    Item { Layout.fillWidth: true }
                }

                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: vpnColumn.implicitHeight + 18
                    radius: Theme.radiusSmall
                    color: Theme.surfaceRaised
                    border.color: Theme.border

                    ColumnLayout {
                        id: vpnColumn
                        anchors.fill: parent
                        anchors.margins: 9
                        spacing: 7

                        Switch {
                            text: root.t("settings.vpnBinding")
                            checked: Boolean(root.advanced("vpnEnabled", false))
                            onToggled: root.setAdvanced("vpnEnabled", checked)
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            enabled: Boolean(root.advanced("vpnEnabled", false))

                            ComboBox {
                                id: vpnMode
                                model: [
                                    {label: root.t("settings.vpnSystem"), value: "system"},
                                    {label: root.t("settings.vpnProxy"), value: "proxy"},
                                    {label: root.t("settings.vpnBind"), value: "bind"}
                                ]
                                textRole: "label"
                                valueRole: "value"
                                currentIndex: {
                                    const mode = String(root.advanced("vpnMode", "system"))
                                    return mode === "proxy" ? 1 : mode === "bind" ? 2 : 0
                                }
                                onActivated: root.setAdvanced("vpnMode", currentValue)
                            }

                            TextField {
                                Layout.fillWidth: true
                                visible: vpnMode.currentValue === "proxy"
                                placeholderText: root.t("settings.vpnProxyUrl")
                                text: String(root.advanced("vpnProxyUrl", ""))
                                LayoutMirroring.enabled: false
                                horizontalAlignment: Text.AlignLeft
                                onEditingFinished: root.setAdvanced("vpnProxyUrl", text)
                            }

                            TextField {
                                Layout.fillWidth: true
                                visible: vpnMode.currentValue === "bind"
                                placeholderText: root.t("settings.vpnBindAddress")
                                text: String(root.advanced("vpnBindAddress", ""))
                                LayoutMirroring.enabled: false
                                horizontalAlignment: Text.AlignLeft
                                onEditingFinished: root.setAdvanced("vpnBindAddress", text)
                            }

                            Switch {
                                text: root.t("settings.vpnKillSwitch")
                                visible: vpnMode.currentValue === "bind"
                                checked: Boolean(root.advanced("vpnKillSwitch", true))
                                onToggled: root.setAdvanced("vpnKillSwitch", checked)
                            }
                        }
                    }
                }

                RowLayout {
                    Layout.fillWidth: true

                    TextField {
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.dnsServers")
                        text: String(root.advanced("dnsServers", ""))
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                        onEditingFinished: root.setAdvanced("dnsServers", text)
                    }
                    SpinBox {
                        from: 0; to: 86400
                        value: Number(root.advanced("dnsCacheTimeoutSec", 300))
                        onValueModified: root.setAdvanced("dnsCacheTimeoutSec", value)
                    }
                    Button {
                        text: root.t("settings.testDns")
                        enabled: api.connected
                        onClicked: api.pingDnsProviders()
                    }
                }

                Repeater {
                    model: api.dnsResults
                    delegate: Text {
                        required property var modelData
                        Layout.fillWidth: true
                        text: String(modelData.name || modelData.ip || "")
                            + ": " + (modelData.latencyMs === null || modelData.latencyMs === undefined
                                ? root.t("settings.timeoutResult")
                                : Number(modelData.latencyMs).toFixed(1) + " ms")
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                    }
                }

                TextField {
                    Layout.fillWidth: true
                    placeholderText: root.t("settings.userAgent")
                    text: String(root.advanced("userAgent", ""))
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                    onEditingFinished: root.setAdvanced("userAgent", text)
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: mediaColumn.implicitHeight + 28
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            ColumnLayout {
                id: mediaColumn
                anchors.fill: parent
                anchors.margins: 14
                spacing: 10

                Text {
                    text: root.t("settings.mediaDefaults")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontBody
                    font.weight: Font.DemiBold
                }

                RowLayout {
                    Layout.fillWidth: true

                    Text { text: root.t("settings.videoQuality"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                    ComboBox {
                        id: qualityBox
                        model: [
                            {label: root.t("settings.best"), value: "best"},
                            {label: "720p", value: "good"},
                            {label: "480p", value: "worst"}
                        ]
                        textRole: "label"
                        valueRole: "value"
                        currentIndex: {
                            const q = String(root.advanced("videoQuality", "best"))
                            return q === "good" ? 1 : q === "worst" ? 2 : 0
                        }
                        onActivated: root.setAdvanced("videoQuality", currentValue)
                    }

                    Switch {
                        text: root.t("settings.downloadSubtitles")
                        checked: Boolean(root.advanced("downloadSubtitles", false))
                        onToggled: root.setAdvanced("downloadSubtitles", checked)
                    }

                    TextField {
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.subtitleLanguage")
                        text: String(root.advanced("subtitleLanguage", ""))
                        onEditingFinished: root.setAdvanced("subtitleLanguage", text)
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    TextField {
                        id: ffmpegPath
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.ffmpegPath")
                        text: String(root.advanced("ffmpegPath", ""))
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                        onEditingFinished: root.setAdvanced("ffmpegPath", text)
                    }
                    Button {
                        text: root.t("common.browse")
                        onClicked: {
                            const path = desktop.chooseOpenFile(
                                ffmpegPath.text,
                                root.t("settings.executableFiles") + " (*)"
                            )
                            if (path.length > 0) {
                                ffmpegPath.text = path
                                root.setAdvanced("ffmpegPath", path)
                                api.runExternalToolAction("ffmpeg", "set-path", path)
                            }
                        }
                    }
                    Switch {
                        text: root.t("settings.ffmpegAutoMerge")
                        checked: Boolean(root.advanced("ffmpegAutoMerge", true))
                        onToggled: root.setAdvanced("ffmpegAutoMerge", checked)
                    }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: toolsColumn.implicitHeight + 28
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            ColumnLayout {
                id: toolsColumn
                anchors.fill: parent
                anchors.margins: 14
                spacing: 9

                RowLayout {
                    Layout.fillWidth: true
                    Text {
                        Layout.fillWidth: true
                        text: root.t("settings.externalTools")
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontBody
                        font.weight: Font.DemiBold
                    }
                    Button {
                        text: root.t("action.refresh")
                        enabled: api.connected
                        onClicked: api.refreshExternalTools()
                    }
                }

                Repeater {
                    model: api.externalTools

                    delegate: Rectangle {
                        required property var modelData
                        Layout.fillWidth: true
                        implicitHeight: toolRow.implicitHeight + 14
                        radius: Theme.radiusSmall
                        color: Theme.surfaceRaised
                        border.color: Theme.border

                        RowLayout {
                            id: toolRow
                            anchors.fill: parent
                            anchors.margins: 7
                            spacing: 7

                            ColumnLayout {
                                Layout.fillWidth: true
                                Text {
                                    text: root.externalToolName(modelData)
                                    color: Theme.textPrimary
                                    font.pixelSize: Theme.fontSmall
                                    font.weight: Font.DemiBold
                                }
                                Text {
                                    text: root.externalToolStatus(modelData)
                                        + (modelData.version ? " · " + modelData.version : "")
                                    color: Theme.textMuted
                                    font.pixelSize: Theme.fontTiny
                                }
                            }

                            Button {
                                text: root.t("settings.discover")
                                onClicked: api.runExternalToolAction(root.externalToolId(modelData), "discover")
                            }
                            Button {
                                text: root.t("settings.health")
                                onClicked: api.runExternalToolAction(root.externalToolId(modelData), "health")
                            }
                            Button {
                                text: root.t("settings.checkUpdates")
                                onClicked: api.runExternalToolAction(root.externalToolId(modelData), "check-updates")
                            }
                            Button {
                                text: root.t("settings.install")
                                onClicked: api.runExternalToolAction(root.externalToolId(modelData), "install")
                            }
                            Button {
                                text: root.t("settings.update")
                                onClicked: api.runExternalToolAction(root.externalToolId(modelData), "update")
                            }
                            Button {
                                text: root.t("settings.setPath")
                                onClicked: {
                                    const path = desktop.chooseOpenFile("", root.t("settings.executableFiles") + " (*)")
                                    if (path.length > 0)
                                        api.runExternalToolAction(root.externalToolId(modelData), "set-path", path)
                                }
                            }
                            Button {
                                text: root.t("settings.uninstall")
                                onClicked: api.runExternalToolAction(root.externalToolId(modelData), "uninstall")
                            }
                        }
                    }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: telegramColumn.implicitHeight + 28
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            ColumnLayout {
                id: telegramColumn
                anchors.fill: parent
                anchors.margins: 14
                spacing: 9

                Text {
                    text: root.t("settings.telegram")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontBody
                    font.weight: Font.DemiBold
                }

                Switch {
                    id: telegramEnabled
                    text: root.t("settings.telegramEnabled")
                    checked: Boolean(api.telegramConfig.enabled)
                }

                TextField {
                    id: telegramToken
                    Layout.fillWidth: true
                    placeholderText: api.telegramConfig.hasToken
                        ? String(api.telegramConfig.token || "****")
                        : root.t("settings.telegramToken")
                    echoMode: TextInput.Password
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                RowLayout {
                    Layout.fillWidth: true

                    TextField {
                        id: telegramChatId
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.telegramChatId")
                        text: api.telegramConfig.chatId !== undefined
                            ? String(api.telegramConfig.chatId)
                            : ""
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                    }

                    TextField {
                        id: telegramApiBase
                        Layout.fillWidth: true
                        text: String(api.telegramConfig.apiBase || "https://api.telegram.org")
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                    }

                    SpinBox {
                        id: telegramLimit
                        from: 1
                        to: 2000
                        value: Number(api.telegramConfig.fileUploadLimitMb || 50)
                    }
                }

                RowLayout {
                    Layout.fillWidth: true

                    Button {
                        text: root.t("settings.saveTelegram")
                        enabled: api.connected
                        onClicked: {
                            const payload = {
                                enabled: telegramEnabled.checked,
                                chatId: Number(telegramChatId.text || 0),
                                apiBase: telegramApiBase.text.trim(),
                                fileUploadLimitMb: telegramLimit.value
                            }
                            if (telegramToken.text.trim().length > 0)
                                payload.token = telegramToken.text.trim()
                            api.updateTelegramConfig(payload)
                            telegramToken.clear()
                        }
                    }

                    Button {
                        text: root.t("settings.testTelegram")
                        enabled: api.connected && Boolean(api.telegramConfig.hasToken)
                        onClicked: api.testTelegram()
                    }

                    Item { Layout.fillWidth: true }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: shortcutsColumn.implicitHeight + 28
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            ColumnLayout {
                id: shortcutsColumn
                anchors.fill: parent
                anchors.margins: 14
                spacing: 8

                Text {
                    text: root.t("settings.shortcuts")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontBody
                    font.weight: Font.DemiBold
                }

                Switch {
                    text: root.t("settings.shortcutsEnabled")
                    checked: settings.shortcutsEnabled
                    onToggled: settings.setShortcutsEnabled(checked)
                }

                GridLayout {
                    Layout.fillWidth: true
                    columns: 2
                    columnSpacing: 10
                    rowSpacing: 6

                    Repeater {
                        model: [
                            {id: "addDownload", label: root.t("settings.shortcutAdd")},
                            {id: "batchDownload", label: root.t("settings.shortcutBatch")},
                            {id: "focusSearch", label: root.t("settings.shortcutSearch")},
                            {id: "deleteSelected", label: root.t("settings.shortcutDelete")},
                            {id: "openSettings", label: root.t("settings.shortcutSettings")},
                            {id: "openScheduler", label: root.t("settings.shortcutScheduler")}
                        ]

                        delegate: RowLayout {
                            required property var modelData
                            Layout.fillWidth: true
                            Text {
                                Layout.preferredWidth: 130
                                text: modelData.label
                                color: Theme.textMuted
                                font.pixelSize: Theme.fontTiny
                            }
                            TextField {
                                Layout.fillWidth: true
                                text: root.shortcut(modelData.id)
                                LayoutMirroring.enabled: false
                                horizontalAlignment: Text.AlignLeft
                                onEditingFinished: settings.setShortcutBinding(modelData.id, text)
                            }
                        }
                    }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: backupColumn.implicitHeight + 28
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            ColumnLayout {
                id: backupColumn
                anchors.fill: parent
                anchors.margins: 14
                spacing: 8

                Text {
                    text: root.t("settings.backupRestore")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontBody
                    font.weight: Font.DemiBold
                }

                Text {
                    Layout.fillWidth: true
                    text: root.t("settings.backupSecurityHint")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontTiny
                    wrapMode: Text.WordWrap
                }

                RowLayout {
                    Layout.fillWidth: true

                    Button {
                        text: root.t("settings.exportSettings")
                        onClicked: {
                            const path = desktop.chooseSaveFile(
                                "nova-settings-backup.json",
                                "JSON (*.json)"
                            )
                            if (path.length > 0) {
                                const ok = settings.exportBackup(path)
                                root.showNotice(
                                    ok ? root.t("settings.exportSuccess") : root.t("settings.exportFailed"),
                                    !ok
                                )
                            }
                        }
                    }

                    Button {
                        text: root.t("settings.importSettings")
                        onClicked: {
                            const path = desktop.chooseOpenFile("", "JSON (*.json)")
                            if (path.length > 0) {
                                const ok = settings.importBackup(path)
                                root.showNotice(
                                    ok ? root.t("settings.importSuccess") : root.t("settings.importFailed"),
                                    !ok
                                )
                            }
                        }
                    }

                    Button {
                        text: root.resetArmed
                            ? root.t("settings.confirmFactoryReset")
                            : root.t("settings.factoryReset")
                        onClicked: {
                            if (root.resetArmed) {
                                settings.resetToDefaults()
                                root.resetArmed = false
                                root.showNotice(root.t("settings.resetComplete"), false)
                            } else {
                                root.resetArmed = true
                            }
                        }
                    }

                    Button {
                        visible: root.resetArmed
                        text: root.t("common.cancel")
                        onClicked: root.resetArmed = false
                    }

                    Item { Layout.fillWidth: true }
                }
            }
        }
    }
}
