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
            Accessible.role: Accessible.AlertMessage
            Accessible.name: root.noticeText

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
                        Accessible.name: root.t("settings.proxyHost")
                        text: String(root.advanced("proxyHost", ""))
                        enabled: Boolean(root.advanced("proxyEnabled", false))
                        onEditingFinished: root.setAdvanced("proxyHost", text)
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                    }

                    TextField {
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.proxyPort")
                        Accessible.name: root.t("settings.proxyPort")
                        text: String(root.advanced("proxyPort", ""))
                        enabled: Boolean(root.advanced("proxyEnabled", false))
                        inputMethodHints: Qt.ImhDigitsOnly
                        onEditingFinished: root.setAdvanced("proxyPort", text)
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                    }

                    TextField {
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.proxyUser")
                        Accessible.name: root.t("settings.proxyUser")
                        text: String(root.advanced("proxyUser", ""))
                        enabled: Boolean(root.advanced("proxyEnabled", false))
                        onEditingFinished: root.setAdvanced("proxyUser", text)
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                    }

                    TextField {
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.proxyPassword")
                        Accessible.name: root.t("settings.proxyPassword")
                        text: String(root.advanced("proxyPassword", ""))
                        enabled: Boolean(root.advanced("proxyEnabled", false))
                        echoMode: TextInput.Password
                        onEditingFinished: root.setAdvanced("proxyPassword", text)
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
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
                                Accessible.name: root.t("settings.vpnProxyUrl")
                                text: String(root.advanced("vpnProxyUrl", ""))
                                LayoutMirroring.enabled: false
                                horizontalAlignment: Text.AlignLeft
                                onEditingFinished: root.setAdvanced("vpnProxyUrl", text)
                            }

                            TextField {
                                Layout.fillWidth: true
                                visible: vpnMode.currentValue === "bind"
                                placeholderText: root.t("settings.vpnBindAddress")
                                Accessible.name: root.t("settings.vpnBindAddress")
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
                        Accessible.name: root.t("settings.dnsServers")
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
                    Accessible.name: root.t("settings.userAgent")
                    text: String(root.advanced("userAgent", ""))
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                    onEditingFinished: root.setAdvanced("userAgent", text)
                }

                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: tlsColumn.implicitHeight + 18
                    radius: Theme.radiusSmall
                    color: Theme.surfaceRaised
                    border.color: Theme.border

                    ColumnLayout {
                        id: tlsColumn
                        anchors.fill: parent
                        anchors.margins: 9
                        spacing: 8

                        Text {
                            text: root.t("settings.httpTls")
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontSmall
                            font.weight: Font.DemiBold
                        }

                        RowLayout {
                            Layout.fillWidth: true

                            Text { text: root.t("settings.keepalive"); color: Theme.textSecondary; font.pixelSize: Theme.fontTiny }
                            SpinBox {
                                from: 0
                                to: 86400
                                value: Number(root.advanced("keepaliveTimeSec", 0))
                                onValueModified: root.setAdvanced("keepaliveTimeSec", value)
                            }

                            Text { text: root.t("settings.httpVersion"); color: Theme.textSecondary; font.pixelSize: Theme.fontTiny }
                            ComboBox {
                                id: httpVersionBox
                                model: [
                                    {label: root.t("settings.automatic"), value: ""},
                                    {label: "HTTP/1.0", value: "1.0"},
                                    {label: "HTTP/1.1", value: "1.1"},
                                    {label: "HTTP/2", value: "2"},
                                    {label: "HTTP/2 prior knowledge", value: "2-prior-knowledge"},
                                    {label: "HTTP/3", value: "3"}
                                ]
                                textRole: "label"
                                valueRole: "value"
                                currentIndex: {
                                    const wanted = String(root.advanced("httpVersion", ""))
                                    for (let i = 0; i < model.length; ++i) {
                                        if (String(model[i].value) === wanted)
                                            return i
                                    }
                                    return 0
                                }
                                onActivated: root.setAdvanced("httpVersion", currentValue)
                            }

                            Text { text: root.t("settings.tlsMinimum"); color: Theme.textSecondary; font.pixelSize: Theme.fontTiny }
                            ComboBox {
                                id: tlsMinBox
                                model: [
                                    {label: root.t("settings.automatic"), value: ""},
                                    {label: "TLS 1.0", value: "1.0"},
                                    {label: "TLS 1.1", value: "1.1"},
                                    {label: "TLS 1.2", value: "1.2"},
                                    {label: "TLS 1.3", value: "1.3"}
                                ]
                                textRole: "label"
                                valueRole: "value"
                                currentIndex: {
                                    const wanted = String(root.advanced("tlsMin", ""))
                                    for (let i = 0; i < model.length; ++i) {
                                        if (String(model[i].value) === wanted)
                                            return i
                                    }
                                    return 0
                                }
                                onActivated: root.setAdvanced("tlsMin", currentValue)
                            }

                            Switch {
                                text: root.t("settings.allowInsecureTls")
                                checked: Boolean(root.advanced("insecure", false))
                                onToggled: root.setAdvanced("insecure", checked)
                            }
                        }

                        RowLayout {
                            Layout.fillWidth: true

                            TextField {
                                Layout.fillWidth: true
                                placeholderText: root.t("settings.caCertificate")
                                Accessible.name: root.t("settings.caCertificate")
                                text: String(root.advanced("caCert", ""))
                                LayoutMirroring.enabled: false
                                horizontalAlignment: Text.AlignLeft
                                onEditingFinished: root.setAdvanced("caCert", text)
                            }
                            Button {
                                text: root.t("common.browse")
                                onClicked: {
                                    const path = desktop.chooseOpenFile(
                                        String(root.advanced("caCert", "")),
                                        root.t("settings.certificateFiles") + " (*)"
                                    )
                                    if (path.length > 0)
                                        root.setAdvanced("caCert", path)
                                }
                            }

                            TextField {
                                Layout.fillWidth: true
                                placeholderText: root.t("settings.clientCertificate")
                                Accessible.name: root.t("settings.clientCertificate")
                                text: String(root.advanced("clientCert", ""))
                                LayoutMirroring.enabled: false
                                horizontalAlignment: Text.AlignLeft
                                onEditingFinished: root.setAdvanced("clientCert", text)
                            }

                            TextField {
                                Layout.fillWidth: true
                                placeholderText: root.t("settings.clientKey")
                                Accessible.name: root.t("settings.clientKey")
                                text: String(root.advanced("clientKey", ""))
                                LayoutMirroring.enabled: false
                                horizontalAlignment: Text.AlignLeft
                                onEditingFinished: root.setAdvanced("clientKey", text)
                            }
                        }

                        TextField {
                            Layout.fillWidth: true
                            placeholderText: root.t("settings.tlsCiphers")
                            Accessible.name: root.t("settings.tlsCiphers")
                            text: String(root.advanced("ciphers", ""))
                            LayoutMirroring.enabled: false
                            horizontalAlignment: Text.AlignLeft
                            onEditingFinished: root.setAdvanced("ciphers", text)
                        }
                    }
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
                        Accessible.name: root.t("settings.subtitleLanguage")
                        text: String(root.advanced("subtitleLanguage", ""))
                        onEditingFinished: root.setAdvanced("subtitleLanguage", text)
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    TextField {
                        id: ffmpegPath
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.ffmpegPath")
                        Accessible.name: root.t("settings.ffmpegPath")
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
                    Accessible.name: root.t("settings.telegramToken")
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                RowLayout {
                    Layout.fillWidth: true

                    TextField {
                        id: telegramChatId
                        Layout.fillWidth: true
                        placeholderText: root.t("settings.telegramChatId")
                        Accessible.name: root.t("settings.telegramChatId")
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
                        Accessible.name: root.t("settings.telegram") + " API"
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
                            {id: "selectAllDownloads", label: root.t("settings.shortcutSelectAll")},
                            {id: "resumeSelected", label: root.t("settings.shortcutResumeSelected")},
                            {id: "resumeAll", label: root.t("settings.shortcutResumeAll")},
                            {id: "stopSelected", label: root.t("settings.shortcutStopSelected")},
                            {id: "stopAll", label: root.t("settings.shortcutStopAll")},
                            {id: "deleteSelected", label: root.t("settings.shortcutDelete")},
                            {id: "deleteCompleted", label: root.t("settings.shortcutDeleteCompleted")},
                            {id: "openSettings", label: root.t("settings.shortcutSettings")},
                            {id: "openScheduler", label: root.t("settings.shortcutScheduler")},
                            {id: "toggleNotifications", label: root.t("settings.shortcutNotifications")},
                            {id: "toggleSpeedLimiter", label: root.t("settings.shortcutSpeedLimiter")}
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
                                Accessible.name: modelData.label
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
                                if (ok) {
                                    const a = settings.advancedSettings || ({})
                                    api.setGlobalBandwidthLimit(
                                        Boolean(a.speedLimiterEnabled)
                                            ? Number(a.speedLimitKbs || 0)
                                            : 0
                                    )
                                    api.setLogLevel(String(a.logLevel || "info"))
                                    const ffmpeg = String(a.ffmpegPath || "").trim()
                                    if (ffmpeg.length > 0)
                                        api.runExternalToolAction("ffmpeg", "set-path", ffmpeg)
                                }
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
                                api.setGlobalBandwidthLimit(0)
                                api.setLogLevel("info")
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
