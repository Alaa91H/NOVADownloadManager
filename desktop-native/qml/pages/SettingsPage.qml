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
            root.showNotice("Diagnostics saved to " + path, false)
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
                    text: "Settings & Diagnostics"
                    color: Theme.textPrimary
                    font.pixelSize: 21
                    font.weight: Font.DemiBold
                }

                Text {
                    text: "Native preferences, Rust engine controls and runtime diagnostics"
                    color: Theme.textMuted
                    font.pixelSize: 10
                }
            }

            Item { Layout.fillWidth: true }

            Button {
                text: "Refresh engine"
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
                font.pixelSize: 10
                elide: Text.ElideRight
            }
        }

        TabBar {
            id: tabs
            Layout.fillWidth: true

            TabButton { text: "General" }
            TabButton { text: "Engine" }
            TabButton { text: "Diagnostics" }
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
                                text: "Download defaults"
                                color: Theme.textPrimary
                                font.pixelSize: 13
                                font.weight: Font.DemiBold
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 8

                                TextField {
                                    id: defaultDirectoryField
                                    Layout.fillWidth: true
                                    text: settings.defaultSaveDirectory
                                    placeholderText: "Default download directory"
                                    selectByMouse: true
                                    onEditingFinished: settings.defaultSaveDirectory = text
                                }

                                Button {
                                    text: "Browse…"
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
                                    text: "Default connections"
                                    color: Theme.textSecondary
                                    font.pixelSize: 10
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
                                text: "Start new workflow downloads immediately"
                                checked: settings.startImmediately
                                onToggled: settings.startImmediately = checked
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
                                text: "Desktop integration"
                                color: Theme.textPrimary
                                font.pixelSize: 13
                                font.weight: Font.DemiBold
                            }

                            Switch {
                                text: "Close window to system tray"
                                checked: settings.closeToTray
                                enabled: tray.available
                                onToggled: settings.closeToTray = checked
                            }

                            Switch {
                                text: "Start minimized to tray"
                                checked: settings.startMinimized
                                enabled: tray.available
                                onToggled: settings.startMinimized = checked
                            }

                            Text {
                                text: tray.available
                                    ? "System tray integration is available."
                                    : "System tray is unavailable in this desktop session."
                                color: tray.available ? Theme.success : Theme.warning
                                font.pixelSize: 9
                            }
                        }
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
                                    text: "Notifications"
                                    color: Theme.textPrimary
                                    font.pixelSize: 13
                                    font.weight: Font.DemiBold
                                }

                                Item { Layout.fillWidth: true }

                                Button {
                                    text: "Test"
                                    enabled: tray.available && settings.notificationsEnabled
                                    onClicked: tray.showNotification(
                                        "NOVA notifications",
                                        "Native desktop notifications are working."
                                    )
                                }
                            }

                            Switch {
                                text: "Enable desktop notifications"
                                checked: settings.notificationsEnabled
                                enabled: tray.available
                                onToggled: settings.notificationsEnabled = checked
                            }

                            Switch {
                                text: "Notify when a download completes"
                                checked: settings.notifyOnComplete
                                enabled: settings.notificationsEnabled && tray.available
                                onToggled: settings.notifyOnComplete = checked
                            }

                            Switch {
                                text: "Notify when a download fails"
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
                                        text: "Updates"
                                        color: Theme.textPrimary
                                        font.pixelSize: 13
                                        font.weight: Font.DemiBold
                                    }

                                    Text {
                                        text: "Current version: " + updater.currentVersion
                                        color: Theme.textMuted
                                        font.pixelSize: 9
                                    }
                                }

                                Item { Layout.fillWidth: true }

                                ComboBox {
                                    id: updateChannel
                                    model: [
                                        { label: "Stable", value: "stable" },
                                        { label: "Preview", value: "preview" }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                    currentIndex: settings.updateChannel === "preview" ? 1 : 0
                                    onActivated: settings.updateChannel = currentValue
                                }

                                Button {
                                    text: updater.busy ? "Checking…" : "Check now"
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
                                    font.pixelSize: 10
                                    elide: Text.ElideRight
                                }

                                Button {
                                    text: "Open release"
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
                                    font.pixelSize: 9
                                    wrapMode: Text.WordWrap
                                }
                            }
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true

                        Item { Layout.fillWidth: true }

                        Button {
                            text: "Reset native preferences"
                            onClicked: settings.resetToDefaults()
                        }
                    }
                }
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
                                    text: "Runtime capabilities"
                                    color: Theme.textPrimary
                                    font.pixelSize: 13
                                    font.weight: Font.DemiBold
                                }

                                Item { Layout.fillWidth: true }

                                Text {
                                    text: api.engineCapabilities.status || "Unknown"
                                    color: api.engineCapabilities.allReady ? Theme.success : Theme.warning
                                    font.pixelSize: 10
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
                                        { label: "Direct", ready: Boolean(api.engineCapabilities.directReady) },
                                        { label: "Media", ready: Boolean(api.engineCapabilities.mediaReady) },
                                        { label: "Post-processing", ready: Boolean(api.engineCapabilities.postProcessingReady) },
                                        { label: "All engines", ready: Boolean(api.engineCapabilities.allReady) }
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
                                                font.pixelSize: 8
                                            }

                                            Text {
                                                text: modelData.ready ? "Ready" : "Unavailable"
                                                color: modelData.ready ? Theme.success : Theme.warning
                                                font.pixelSize: 11
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
                                        font.pixelSize: 10
                                        font.weight: Font.DemiBold
                                    }

                                    Text {
                                        Layout.fillWidth: true
                                        text: item.version || (item.available ? "Available" : "Unavailable")
                                        color: Theme.textMuted
                                        font.pixelSize: 9
                                        elide: Text.ElideRight
                                    }

                                    Text {
                                        text: item.available ? "READY" : "OFFLINE"
                                        color: item.available ? Theme.success : Theme.warning
                                        font.pixelSize: 9
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
                                text: "Engine profile"
                                color: Theme.textPrimary
                                font.pixelSize: 13
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
                                                font.pixelSize: 11
                                                font.weight: Font.DemiBold
                                            }

                                            Text {
                                                Layout.fillWidth: true
                                                text: (modelData.description || "")
                                                    + " · " + modelData.default_connections
                                                    + " default / " + modelData.max_connections + " max connections"
                                                color: Theme.textMuted
                                                font.pixelSize: 9
                                                elide: Text.ElideRight
                                            }
                                        }

                                        Button {
                                            text: modelData.id === api.activeEngineProfile
                                                ? "Active"
                                                : "Use profile"
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
                                text: "Bandwidth & retry policy"
                                color: Theme.textPrimary
                                font.pixelSize: 13
                                font.weight: Font.DemiBold
                            }

                            RowLayout {
                                Layout.fillWidth: true

                                Text {
                                    text: "Global limit (KB/s, 0 = unlimited)"
                                    color: Theme.textSecondary
                                    font.pixelSize: 10
                                }

                                Item { Layout.fillWidth: true }

                                SpinBox {
                                    from: 0
                                    to: 1000000
                                    editable: true
                                    value: Number(api.bandwidthState.global_limit_kbps || 0)
                                    onValueModified: api.setGlobalBandwidthLimit(value)
                                }

                                Switch {
                                    text: "Pause all"
                                    checked: Boolean(api.bandwidthState.paused)
                                    onToggled: api.setBandwidthPaused(checked)
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true

                                Text {
                                    text: "Retry policy: "
                                        + Number(api.retryPolicy.max_retries || 0) + " retries · "
                                        + Number(api.retryPolicy.base_delay_secs || 0) + "s base delay"
                                    color: Theme.textSecondary
                                    font.pixelSize: 10
                                }

                                Item { Layout.fillWidth: true }

                                ComboBox {
                                    id: retryPreset
                                    model: [
                                        { label: "Default", value: "default" },
                                        { label: "Aggressive", value: "aggressive" },
                                        { label: "Conservative", value: "conservative" },
                                        { label: "No retry", value: "none" }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                }

                                Button {
                                    text: "Apply"
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
                            text: api.diagnosticsBusy ? "Running diagnostics…" : "Run full diagnostics"
                            enabled: api.connected && !api.diagnosticsBusy
                            onClicked: api.runDiagnostics()
                        }

                        Button {
                            text: "Save report"
                            enabled: !api.diagnosticsBusy
                                && api.diagnosticsReport
                                && Object.keys(api.diagnosticsReport).length > 0
                            onClicked: api.saveDiagnosticsReport()
                        }

                        Item { Layout.fillWidth: true }

                        Text {
                            text: api.logDirectory.length > 0
                                ? api.logDirectory
                                : "Log directory unavailable"
                            color: Theme.textMuted
                            font.pixelSize: 9
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
                                    { label: "Status", value: root.diagnosticSummary().status || "Not run" },
                                    { label: "Network", value: root.diagnosticSummary().networkReachable ? "Reachable" : "Unknown / offline" },
                                    { label: "Jobs", value: String(root.diagnosticSummary().jobsRunning || 0) },
                                    { label: "Memory", value: String(root.diagnosticSummary().memoryUsageMb || 0) + " MB" },
                                    { label: "Disk free", value: String(root.diagnosticSummary().diskFreeGb || 0) + " GB" }
                                ]

                                delegate: ColumnLayout {
                                    required property var modelData
                                    Layout.fillWidth: true
                                    spacing: 3

                                    Text {
                                        text: modelData.label
                                        color: Theme.textMuted
                                        font.pixelSize: 8
                                    }

                                    Text {
                                        Layout.fillWidth: true
                                        text: modelData.value
                                        color: Theme.textPrimary
                                        font.pixelSize: 11
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
                            text: "Runtime logs"
                            color: Theme.textPrimary
                            font.pixelSize: 13
                            font.weight: Font.DemiBold
                        }

                        Item { Layout.fillWidth: true }

                        ComboBox {
                            id: logFilter
                            model: ["all", "trace", "debug", "info", "warn", "error"]
                        }

                        Button {
                            text: "Refresh"
                            onClicked: api.refreshLogs(logFilter.currentText, 300)
                        }

                        ComboBox {
                            id: logLevel
                            model: ["off", "error", "warn", "info", "debug", "trace"]
                            Component.onCompleted: currentIndex = Math.max(0, model.indexOf(api.logLevel))
                        }

                        Button {
                            text: "Set level"
                            enabled: api.connected
                            onClicked: api.setLogLevel(logLevel.currentText)
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
                                        font.pixelSize: 8
                                        font.weight: Font.Bold
                                    }

                                    ColumnLayout {
                                        Layout.fillWidth: true
                                        spacing: 1

                                        Text {
                                            Layout.fillWidth: true
                                            text: modelData.message || ""
                                            color: Theme.textPrimary
                                            font.pixelSize: 9
                                            elide: Text.ElideRight
                                        }

                                        Text {
                                            Layout.fillWidth: true
                                            text: (modelData.timestamp || "")
                                                + (modelData.target ? " · " + modelData.target : "")
                                            color: Theme.textMuted
                                            font.pixelSize: 8
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
