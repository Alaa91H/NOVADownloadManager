import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var api
    required property var settings
    required property var tray
    required property var desktop
    required property var updater

    property string noticeText: ""
    property bool noticeError: false
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function languageIndex() {
        const code = settings.uiLanguage
        for (let i = 0; i < i18n.supportedLanguages.length; ++i) {
            if (i18n.supportedLanguages[i].code === code)
                return i
        }
        return 0
    }

    function engine(id) {
        const caps = api.engineCapabilities || ({})
        const engines = caps.engines || ({})
        return engines[id] || ({})
    }

    function diagnosticSummary() {
        const report = api.diagnosticsReport || ({})
        return report.summary || ({})
    }

    function diagnosticSystem() {
        const report = api.diagnosticsReport || ({})
        return report.system || ({})
    }

    function showNotice(message, error) {
        noticeText = message
        noticeError = error
        noticeTimer.restart()
    }

    Component.onCompleted: {
        api.refreshEngineManagement()
        api.refreshLogs("", 300)
    }

    Connections {
        target: updater

        function onUpdateCheckFailed(message) {
            root.showNotice(message, true)
        }
    }

    Connections {
        target: api

        function onEngineManagementFailed(message) {
            root.showNotice(message, true)
        }

        function onDiagnosticsFailed(message) {
            root.showNotice(message, true)
        }

        function onDiagnosticsSaved(path) {
            root.showNotice(root.t("settings.diagnosticsSaved") + " " + path, false)
        }

        function onLogsFailed(message) {
            root.showNotice(message, true)
        }
    }

    Timer {
        id: noticeTimer
        interval: 5000
        onTriggered: root.noticeText = ""
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12

        RowLayout {
            Layout.fillWidth: true

            ColumnLayout {
                spacing: 2

                Text {
                    text: root.t("settings.title")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontTitle
                    font.weight: Font.DemiBold
                }

                Text {
                    text: root.t("settings.subtitle")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontSmall
                }
            }

            Item { Layout.fillWidth: true }

            Button {
                text: root.t("settings.refreshEngine")
                enabled: api.connected
                onClicked: api.refreshEngineManagement()
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 34
            visible: root.noticeText.length > 0
            radius: Theme.radiusMedium
            color: root.noticeError
                ? Qt.rgba(0.97, 0.32, 0.29, 0.10)
                : Qt.rgba(0.25, 0.73, 0.31, 0.10)
            border.color: root.noticeError ? Theme.danger : Theme.success

            Text {
                anchors.fill: parent
                anchors.margins: 9
                text: root.noticeText
                color: root.noticeError ? Theme.danger : Theme.success
                font.pixelSize: Theme.fontSmall
                elide: Text.ElideRight
            }
        }

        TabBar {
            id: tabs
            Layout.fillWidth: true

            TabButton { text: root.t("settings.general") }
            TabButton { text: root.t("settings.advanced") }
            TabButton { text: root.t("settings.engine") }
            TabButton { text: root.t("settings.diagnostics") }
        }

        StackLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            currentIndex: tabs.currentIndex

            ScrollView {
                clip: true

                ColumnLayout {
                    width: parent.availableWidth
                    spacing: 12


                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: appearanceColumn.implicitHeight + 28
                        radius: Theme.radiusMedium
                        color: Theme.surface
                        border.color: Theme.border

                        ColumnLayout {
                            id: appearanceColumn
                            anchors.fill: parent
                            anchors.margins: 14
                            spacing: 12

                            Text {
                                text: root.t("settings.appearance")
                                color: Theme.textPrimary
                                font.pixelSize: Theme.fontMedium
                                font.weight: Font.DemiBold
                            }

                            GridLayout {
                                Layout.fillWidth: true
                                columns: 2
                                columnSpacing: 12
                                rowSpacing: 10

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 4

                                    Text {
                                        text: root.t("settings.language")
                                        color: Theme.textMuted
                                        font.pixelSize: Theme.fontSmall
                                    }

                                    ComboBox {
                                        id: languageBox
                                        Layout.fillWidth: true
                                        model: i18n.supportedLanguages
                                        textRole: "label"
                                        valueRole: "code"
                                        currentIndex: root.languageIndex()
                                        Accessible.name: root.t("settings.language")
                                        onActivated: settings.uiLanguage = currentValue
                                    }
                                }

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 4

                                    Text {
                                        text: root.t("settings.theme")
                                        color: Theme.textMuted
                                        font.pixelSize: Theme.fontSmall
                                    }

                                    ComboBox {
                                        id: appearanceBox
                                        Layout.fillWidth: true
                                        model: [
                                            { label: root.t("settings.system"), value: "system" },
                                            { label: root.t("settings.light"), value: "light" },
                                            { label: root.t("settings.dark"), value: "dark" }
                                        ]
                                        textRole: "label"
                                        valueRole: "value"
                                        currentIndex: settings.appearanceMode === "light"
                                            ? 1
                                            : settings.appearanceMode === "dark" ? 2 : 0
                                        Accessible.name: root.t("settings.theme")
                                        onActivated: settings.appearanceMode = currentValue
                                    }
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 18

                                Switch {
                                    text: root.t("settings.highContrast")
                                    checked: settings.highContrast
                                    Accessible.name: text
                                    onToggled: settings.highContrast = checked
                                }

                                Switch {
                                    text: root.t("settings.reducedMotion")
                                    checked: settings.reducedMotion
                                    Accessible.name: text
                                    onToggled: settings.reducedMotion = checked
                                }

                                Item { Layout.fillWidth: true }
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 10

                                Text {
                                    text: root.t("settings.fontScale")
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                }

                                Slider {
                                    id: fontScaleSlider
                                    Layout.fillWidth: true
                                    from: 0.85
                                    to: 1.35
                                    stepSize: 0.05
                                    value: settings.fontScale
                                    Accessible.name: root.t("settings.fontScale")
                                    onMoved: settings.fontScale = value
                                }

                                Text {
                                    text: Math.round(settings.fontScale * 100) + "%"
                                    color: Theme.textPrimary
                                    font.pixelSize: Theme.fontSmall
                                    font.family: "monospace"
                                }
                            }
                        }
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: generalColumn.implicitHeight + 28
                        radius: Theme.radiusMedium
                        color: Theme.surface
                        border.color: Theme.border

                        ColumnLayout {
                            id: generalColumn
                            anchors.fill: parent
                            anchors.margins: 14
                            spacing: 12

                            Text {
                                text: root.t("settings.downloadDefaults")
                                color: Theme.textPrimary
                                font.pixelSize: Theme.fontBody
                                font.weight: Font.DemiBold
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 8

                                TextField {
                                    id: defaultDirectoryField
                                    Layout.fillWidth: true
                                    text: settings.defaultSaveDirectory
                                    placeholderText: root.t("settings.defaultDirectory")
                                    Accessible.name: root.t("settings.defaultDirectory")
                                    LayoutMirroring.enabled: false
                                    horizontalAlignment: Text.AlignLeft
                                    selectByMouse: true
                                    onEditingFinished: settings.defaultSaveDirectory = text
                                }

                                Button {
                                    text: root.t("common.browse")
                                    onClicked: {
                                        const chosen = desktop.chooseDirectory(defaultDirectoryField.text)
                                        if (chosen.length > 0) {
                                            defaultDirectoryField.text = chosen
                                            settings.defaultSaveDirectory = chosen
                                        }
                                    }
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true

                                Text {
                                    text: root.t("settings.defaultConnections")
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                }

                                Item { Layout.fillWidth: true }

                                SpinBox {
                                    from: 1
                                    to: 64
                                    value: settings.defaultConnections
                                    onValueModified: settings.defaultConnections = value
                                }
                            }

                            Switch {
                                text: root.t("settings.startWorkflowImmediately")
                                Accessible.name: text
                                checked: settings.startImmediately
                                onToggled: settings.startImmediately = checked
                            }

                            Switch {
                                text: root.t("settings.monitorClipboard")
                                Accessible.name: text
                                Accessible.description: root.t("settings.monitorClipboardHint")
                                checked: settings.monitorClipboard
                                enabled: api.connected
                                onToggled: settings.monitorClipboard = checked
                            }

                            Text {
                                Layout.fillWidth: true
                                text: root.t("settings.monitorClipboardHint")
                                color: Theme.textMuted
                                font.pixelSize: Theme.fontTiny
                                wrapMode: Text.WordWrap
                            }
                        }
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: desktopColumn.implicitHeight + 28
                        radius: Theme.radiusMedium
                        color: Theme.surface
                        border.color: Theme.border

                        ColumnLayout {
                            id: desktopColumn
                            anchors.fill: parent
                            anchors.margins: 14
                            spacing: 10

                            Text {
                                text: root.t("settings.desktopIntegration")
                                color: Theme.textPrimary
                                font.pixelSize: Theme.fontBody
                                font.weight: Font.DemiBold
                            }

                            Switch {
                                text: root.t("settings.closeToTray")
                                Accessible.name: text
                                checked: settings.closeToTray
                                enabled: tray.available
                                onToggled: settings.closeToTray = checked
                            }

                            Switch {
                                text: root.t("settings.startMinimized")
                                Accessible.name: text
                                checked: settings.startMinimized
                                enabled: tray.available
                                onToggled: settings.startMinimized = checked
                            }

                            Text {
                                text: tray.available
                                    ? root.t("settings.trayAvailable")
                                    : root.t("settings.trayUnavailable")
                                color: tray.available ? Theme.success : Theme.warning
                                font.pixelSize: Theme.fontTiny
                            }
                        }
                    }

                    BrowserIntegrationPanel {
                        api: root.api
                        desktop: root.desktop
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: notificationColumn.implicitHeight + 28
                        radius: Theme.radiusMedium
                        color: Theme.surface
                        border.color: Theme.border

                        ColumnLayout {
                            id: notificationColumn
                            anchors.fill: parent
                            anchors.margins: 14
                            spacing: 10

                            RowLayout {
                                Layout.fillWidth: true

                                Text {
                                    text: root.t("settings.notifications")
                                    color: Theme.textPrimary
                                    font.pixelSize: Theme.fontBody
                                    font.weight: Font.DemiBold
                                }

                                Item { Layout.fillWidth: true }

                                Button {
                                    text: root.t("settings.test")
                                    enabled: tray.available && settings.notificationsEnabled
                                    onClicked: tray.showNotification(
                                        root.t("settings.notificationTitle"),
                                        root.t("settings.notificationTest")
                                    )
                                }
                            }

                            Switch {
                                text: root.t("settings.enableNotifications")
                                Accessible.name: text
                                checked: settings.notificationsEnabled
                                enabled: tray.available
                                onToggled: settings.notificationsEnabled = checked
                            }

                            Switch {
                                text: root.t("settings.notifyComplete")
                                Accessible.name: text
                                checked: settings.notifyOnComplete
                                enabled: settings.notificationsEnabled && tray.available
                                onToggled: settings.notifyOnComplete = checked
                            }

                            Switch {
                                text: root.t("settings.notifyFailure")
                                Accessible.name: text
                                checked: settings.notifyOnFailure
                                enabled: settings.notificationsEnabled && tray.available
                                onToggled: settings.notifyOnFailure = checked
                            }
                        }
                    }


                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: updatesColumn.implicitHeight + 28
                        radius: Theme.radiusMedium
                        color: Theme.surface
                        border.color: Theme.border

                        ColumnLayout {
                            id: updatesColumn
                            anchors.fill: parent
                            anchors.margins: 14
                            spacing: 10

                            RowLayout {
                                Layout.fillWidth: true

                                ColumnLayout {
                                    spacing: 2

                                    Text {
                                        text: root.t("settings.updates")
                                        color: Theme.textPrimary
                                        font.pixelSize: Theme.fontBody
                                        font.weight: Font.DemiBold
                                    }

                                    Text {
                                        text: root.t("settings.currentVersion") + ": " + updater.currentVersion
                                        color: Theme.textMuted
                                        font.pixelSize: Theme.fontTiny
                                    }
                                }

                                Item { Layout.fillWidth: true }

                                ComboBox {
                                    id: updateChannel
                                    model: [
                                        { label: root.t("settings.stable"), value: "stable" },
                                        { label: root.t("settings.preview"), value: "preview" }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                    currentIndex: settings.updateChannel === "preview" ? 1 : 0
                                    onActivated: settings.updateChannel = currentValue
                                }

                                Button {
                                    text: updater.busy ? root.t("settings.checking") : root.t("settings.checkNow")
                                    enabled: !updater.busy
                                    onClicked: updater.checkForUpdates(settings.updateChannel)
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true

                                Text {
                                    Layout.fillWidth: true
                                    text: updater.latestVersion.length > 0
                                        ? updater.statusText + " · latest " + updater.latestVersion
                                        : updater.statusText
                                    color: updater.updateAvailable ? Theme.success : Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                    elide: Text.ElideRight
                                }

                                Button {
                                    text: root.t("settings.openRelease")
                                    visible: updater.releaseUrl.length > 0
                                    onClicked: updater.openReleasePage()
                                }
                            }

                            Rectangle {
                                Layout.fillWidth: true
                                implicitHeight: updaterSafetyText.implicitHeight + 16
                                radius: Theme.radiusSmall
                                color: Qt.rgba(0.82, 0.60, 0.13, 0.08)
                                border.color: Theme.warning

                                Text {
                                    id: updaterSafetyText
                                    anchors.fill: parent
                                    anchors.margins: 8
                                    text: updater.automaticInstallStatus
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontTiny
                                    wrapMode: Text.WordWrap
                                }
                            }
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true

                        Item { Layout.fillWidth: true }

                        Button {
                            text: root.t("settings.resetPreferences")
                            onClicked: settings.resetToDefaults()
                        }
                    }
                }
            }

            SettingsAdvancedPanel {
                api: root.api
                settings: root.settings
                desktop: root.desktop
            }

            ScrollView {
                clip: true

                ColumnLayout {
                    width: parent.availableWidth
                    spacing: 12

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: capabilitiesColumn.implicitHeight + 28
                        radius: Theme.radiusMedium
                        color: Theme.surface
                        border.color: Theme.border

                        ColumnLayout {
                            id: capabilitiesColumn
                            anchors.fill: parent
                            anchors.margins: 14
                            spacing: 10

                            RowLayout {
                                Layout.fillWidth: true

                                Text {
                                    text: root.t("settings.runtimeCapabilities")
                                    color: Theme.textPrimary
                                    font.pixelSize: Theme.fontBody
                                    font.weight: Font.DemiBold
                                }

                                Item { Layout.fillWidth: true }

                                Text {
                                    text: api.engineCapabilities.status || root.t("common.unknown")
                                    color: api.engineCapabilities.allReady ? Theme.success : Theme.warning
                                    font.pixelSize: Theme.fontSmall
                                    font.weight: Font.DemiBold
                                }
                            }

                            GridLayout {
                                Layout.fillWidth: true
                                columns: 4
                                columnSpacing: 8
                                rowSpacing: 8

                                Repeater {
                                    model: [
                                        { label: root.t("settings.direct"), ready: Boolean(api.engineCapabilities.directReady) },
                                        { label: root.t("settings.media"), ready: Boolean(api.engineCapabilities.mediaReady) },
                                        { label: root.t("settings.postProcessing"), ready: Boolean(api.engineCapabilities.postProcessingReady) },
                                        { label: root.t("settings.allEngines"), ready: Boolean(api.engineCapabilities.allReady) }
                                    ]

                                    delegate: Rectangle {
                                        required property var modelData
                                        Layout.fillWidth: true
                                        Layout.preferredHeight: 54
                                        radius: Theme.radiusSmall
                                        color: Theme.surfaceRaised
                                        border.color: modelData.ready ? Theme.success : Theme.border

                                        ColumnLayout {
                                            anchors.fill: parent
                                            anchors.margins: 9
                                            spacing: 2

                                            Text {
                                                text: modelData.label
                                                color: Theme.textMuted
                                                font.pixelSize: Math.max(8, Theme.fontTiny - 1)
                                            }

                                            Text {
                                                text: modelData.ready ? root.t("settings.ready") : root.t("settings.unavailable")
                                                color: modelData.ready ? Theme.success : Theme.warning
                                                font.pixelSize: Math.round(11 * Theme.fontScale)
                                                font.weight: Font.DemiBold
                                            }
                                        }
                                    }
                                }
                            }

                            Repeater {
                                model: ["libcurlMulti", "ytdlp", "ffmpeg"]

                                delegate: RowLayout {
                                    required property string modelData
                                    Layout.fillWidth: true

                                    readonly property var item: root.engine(modelData)

                                    Text {
                                        Layout.preferredWidth: 130
                                        text: modelData
                                        color: Theme.textPrimary
                                        font.pixelSize: Theme.fontSmall
                                        font.weight: Font.DemiBold
                                    }

                                    Text {
                                        Layout.fillWidth: true
                                        text: item.version || (item.available ? root.t("settings.ready") : root.t("settings.unavailable"))
                                        color: Theme.textMuted
                                        font.pixelSize: Theme.fontTiny
                                        elide: Text.ElideRight
                                    }

                                    Text {
                                        text: item.available ? root.t("settings.ready").toUpperCase() : root.t("settings.offline")
                                        color: item.available ? Theme.success : Theme.warning
                                        font.pixelSize: Theme.fontTiny
                                        font.weight: Font.Bold
                                    }
                                }
                            }
                        }
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: profilesColumn.implicitHeight + 28
                        radius: Theme.radiusMedium
                        color: Theme.surface
                        border.color: Theme.border

                        ColumnLayout {
                            id: profilesColumn
                            anchors.fill: parent
                            anchors.margins: 14
                            spacing: 9

                            Text {
                                text: root.t("settings.engineProfile")
                                color: Theme.textPrimary
                                font.pixelSize: Theme.fontBody
                                font.weight: Font.DemiBold
                            }

                            Repeater {
                                model: api.engineProfiles

                                delegate: Rectangle {
                                    required property var modelData
                                    Layout.fillWidth: true
                                    Layout.preferredHeight: 66
                                    radius: Theme.radiusSmall
                                    color: modelData.id === api.activeEngineProfile
                                        ? Theme.surfaceSelected
                                        : Theme.surfaceRaised
                                    border.color: modelData.id === api.activeEngineProfile
                                        ? Theme.accent
                                        : Theme.border

                                    RowLayout {
                                        anchors.fill: parent
                                        anchors.margins: 9
                                        spacing: 10

                                        ColumnLayout {
                                            Layout.fillWidth: true
                                            spacing: 2

                                            Text {
                                                text: modelData.name || modelData.id
                                                color: Theme.textPrimary
                                                font.pixelSize: Math.round(11 * Theme.fontScale)
                                                font.weight: Font.DemiBold
                                            }

                                            Text {
                                                Layout.fillWidth: true
                                                text: (modelData.description || "")
                                                    + " · " + modelData.default_connections
                                                    + " default / " + modelData.max_connections + " max connections"
                                                color: Theme.textMuted
                                                font.pixelSize: Theme.fontTiny
                                                elide: Text.ElideRight
                                            }
                                        }

                                        Button {
                                            text: modelData.id === api.activeEngineProfile
                                                ? root.t("settings.active")
                                                : root.t("settings.useProfile")
                                            enabled: api.connected
                                                && modelData.id !== api.activeEngineProfile
                                            onClicked: api.setActiveEngineProfile(modelData.id)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: bandwidthColumn.implicitHeight + 28
                        radius: Theme.radiusMedium
                        color: Theme.surface
                        border.color: Theme.border

                        ColumnLayout {
                            id: bandwidthColumn
                            anchors.fill: parent
                            anchors.margins: 14
                            spacing: 10

                            Text {
                                text: root.t("settings.bandwidthRetry")
                                color: Theme.textPrimary
                                font.pixelSize: Theme.fontBody
                                font.weight: Font.DemiBold
                            }

                            RowLayout {
                                Layout.fillWidth: true

                                Text {
                                    text: root.t("settings.globalLimit")
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                }

                                Item { Layout.fillWidth: true }

                                SpinBox {
                                    Accessible.name: root.t("settings.globalLimit")
                                    from: 0
                                    to: 1000000
                                    editable: true
                                    value: Number(api.bandwidthState.global_limit_kbps || 0)
                                    onValueModified: api.setGlobalBandwidthLimit(value)
                                }

                                Switch {
                                    text: root.t("settings.pauseAll")
                                    Accessible.name: text
                                    checked: Boolean(api.bandwidthState.paused)
                                    onToggled: api.setBandwidthPaused(checked)
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true

                                Text {
                                    text: root.t("settings.retryPolicy") + ": "
                                        + Number(api.retryPolicy.max_retries || 0) + " " + root.t("settings.retries") + " · "
                                        + Number(api.retryPolicy.base_delay_secs || 0) + "s " + root.t("settings.baseDelay")
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                }

                                Item { Layout.fillWidth: true }

                                ComboBox {
                                    id: retryPreset
                                    Accessible.name: root.t("settings.retryPolicy")
                                    model: [
                                        { label: root.t("settings.defaultPreset"), value: "default" },
                                        { label: root.t("settings.aggressive"), value: "aggressive" },
                                        { label: root.t("settings.conservative"), value: "conservative" },
                                        { label: root.t("settings.noRetry"), value: "none" }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                }

                                Button {
                                    text: root.t("settings.apply")
                                    enabled: api.connected
                                    onClicked: api.applyRetryPreset(retryPreset.currentValue)
                                }
                            }
                        }
                    }
                }
            }

            Item {
                ColumnLayout {
                    anchors.fill: parent
                    spacing: 10

                    RowLayout {
                        Layout.fillWidth: true

                        Button {
                            text: api.diagnosticsBusy ? root.t("settings.runningDiagnostics") : root.t("settings.runDiagnostics")
                            enabled: api.connected && !api.diagnosticsBusy
                            onClicked: api.runDiagnostics()
                        }

                        Button {
                            text: root.t("settings.saveReport")
                            enabled: !api.diagnosticsBusy
                                && api.diagnosticsReport
                                && Object.keys(api.diagnosticsReport).length > 0
                            onClicked: api.saveDiagnosticsReport()
                        }

                        Item { Layout.fillWidth: true }

                        Text {
                            text: api.logDirectory.length > 0
                                ? api.logDirectory
                                : root.t("settings.logUnavailable")
                            LayoutMirroring.enabled: false
                            horizontalAlignment: Text.AlignLeft
                            color: Theme.textMuted
                            font.pixelSize: Theme.fontTiny
                            elide: Text.ElideMiddle
                        }
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        Layout.preferredHeight: 92
                        radius: Theme.radiusMedium
                        color: Theme.surface
                        border.color: Theme.border

                        GridLayout {
                            anchors.fill: parent
                            anchors.margins: 12
                            columns: 5
                            columnSpacing: 14

                            Repeater {
                                model: [
                                    { label: root.t("common.status"), value: root.diagnosticSummary().status || root.t("settings.notRun") },
                                    { label: root.t("settings.network"), value: root.diagnosticSummary().networkReachable ? root.t("settings.reachable") : root.t("settings.offlineUnknown") },
                                    { label: root.t("settings.jobs"), value: String(root.diagnosticSummary().jobsRunning || 0) },
                                    { label: root.t("settings.memory"), value: String(root.diagnosticSummary().memoryUsageMb || 0) + " MB" },
                                    { label: root.t("settings.diskFree"), value: String(root.diagnosticSummary().diskFreeGb || 0) + " GB" }
                                ]

                                delegate: ColumnLayout {
                                    required property var modelData
                                    Layout.fillWidth: true
                                    spacing: 3

                                    Text {
                                        text: modelData.label
                                        color: Theme.textMuted
                                        font.pixelSize: Math.max(8, Theme.fontTiny - 1)
                                    }

                                    Text {
                                        Layout.fillWidth: true
                                        text: modelData.value
                                        color: Theme.textPrimary
                                        font.pixelSize: Math.round(11 * Theme.fontScale)
                                        font.weight: Font.DemiBold
                                        elide: Text.ElideRight
                                    }
                                }
                            }
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true

                        Text {
                            text: root.t("settings.runtimeLogs")
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontBody
                            font.weight: Font.DemiBold
                        }

                        Item { Layout.fillWidth: true }

                        ComboBox {
                            id: logFilter
                            model: ["all", "trace", "debug", "info", "warn", "error"]
                        }

                        Button {
                            text: root.t("action.refresh")
                            onClicked: api.refreshLogs(logFilter.currentText, 300)
                        }

                        ComboBox {
                            id: logLevel
                            model: ["off", "error", "warn", "info", "debug", "trace"]
                            Component.onCompleted: currentIndex = Math.max(0, model.indexOf(api.logLevel))
                        }

                        Button {
                            text: root.t("settings.setLevel")
                            enabled: api.connected
                            onClicked: {
                                settings.setAdvancedValue("logLevel", logLevel.currentText)
                                api.setLogLevel(logLevel.currentText)
                            }
                        }
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        radius: Theme.radiusMedium
                        color: Theme.surface
                        border.color: Theme.border
                        clip: true

                        ListView {
                            id: logList
                            anchors.fill: parent
                            anchors.margins: 1
                            model: api.logEntries
                            clip: true
                            spacing: 1
                            ScrollBar.vertical: ScrollBar {}

                            delegate: Rectangle {
                                required property var modelData
                                width: logList.width
                                Accessible.name: modelData.level + " " + (modelData.message || "")
                                Accessible.description: (modelData.timestamp || "") + (modelData.target ? " · " + modelData.target : "")
                                height: 46
                                color: modelData.level === "ERROR"
                                    ? Qt.rgba(0.97, 0.32, 0.29, 0.08)
                                    : modelData.level === "WARN"
                                        ? Qt.rgba(0.82, 0.60, 0.13, 0.08)
                                        : "transparent"

                                RowLayout {
                                    anchors.fill: parent
                                    anchors.leftMargin: 9
                                    anchors.rightMargin: 9
                                    spacing: 8

                                    Text {
                                        Layout.preferredWidth: 54
                                        text: modelData.level || "INFO"
                                        color: modelData.level === "ERROR"
                                            ? Theme.danger
                                            : modelData.level === "WARN"
                                                ? Theme.warning
                                                : Theme.textMuted
                                        font.pixelSize: Math.max(8, Theme.fontTiny - 1)
                                        font.weight: Font.Bold
                                    }

                                    ColumnLayout {
                                        Layout.fillWidth: true
                                        spacing: 1

                                        Text {
                                            Layout.fillWidth: true
                                            text: modelData.message || ""
                                            color: Theme.textPrimary
                                            font.pixelSize: Theme.fontTiny
                                            elide: Text.ElideRight
                                        }

                                        Text {
                                            Layout.fillWidth: true
                                            text: (modelData.timestamp || "")
                                                + (modelData.target ? " · " + modelData.target : "")
                                            color: Theme.textMuted
                                            font.pixelSize: Math.max(8, Theme.fontTiny - 1)
                                            elide: Text.ElideRight
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
