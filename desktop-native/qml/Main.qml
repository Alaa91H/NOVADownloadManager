import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Window
import Nova.Native

ApplicationWindow {
    id: window

    visible: !nativeSettings.startMinimized || !trayManager.enabled
    width: 1540
    height: 900
    minimumWidth: 1100
    minimumHeight: 700
    title: t("app.name")
    color: "transparent"
    flags: Qt.Window | Qt.FramelessWindowHint

    property string currentPage: "downloads"
    property string languageToken: i18n.language
    property bool customizationOpen: false

    LayoutMirroring.enabled: i18n.rtl
    LayoutMirroring.childrenInherit: true

    function t(key) {
        const token = window.languageToken
        return i18n.translate(key)
    }

    function isDownloadsPage() {
        return currentPage === "downloads"
            || currentPage === "active"
            || currentPage === "queued"
            || currentPage === "completed"
            || currentPage === "failed"
    }

    function syncUiPreferences() {
        i18n.setLanguage(nativeSettings.uiLanguage)

        const mode = nativeSettings.appearanceMode
        Theme.darkMode = mode === "dark"
            || (mode === "system" && appearanceManager.systemDark)
        Theme.highContrast = nativeSettings.highContrast
        Theme.reducedMotion = nativeSettings.reducedMotion
        Theme.fontScale = nativeSettings.fontScale
        Theme.accentBase = nativeSettings.accentColor
        Theme.radiusBase = nativeSettings.cornerRadius
        Theme.densityScale = nativeSettings.interfaceDensity === "dense"
            ? 0.80
            : nativeSettings.interfaceDensity === "compact" ? 0.90 : 1.0
    }

    function openNewDownload() {
        window.currentPage = "downloads"
        Qt.callLater(function() {
            if (contentLoader.item && contentLoader.item.openNewDownload)
                contentLoader.item.openNewDownload()
        })
    }

    function applyTopSearch(value) {
        if (contentLoader.item && contentLoader.item.setSearchQuery)
            contentLoader.item.setSearchQuery(value)
    }

    function toggleMaximized() {
        if (window.visibility === Window.Maximized)
            window.showNormal()
        else
            window.showMaximized()
    }

    Component.onCompleted: syncUiPreferences()

    Connections {
        target: nativeSettings
        function onSettingsChanged() {
            window.syncUiPreferences()
        }
    }

    Connections {
        target: appearanceManager
        function onSystemThemeChanged() {
            window.syncUiPreferences()
        }
    }

    Connections {
        target: clipboardMonitor
        function onUrlDetected(url, sourceText) {
            if (!novaApi.connected)
                return

            window.currentPage = "downloads"
            Qt.callLater(function() {
                if (contentLoader.item
                    && contentLoader.item.openClipboardUrl
                    && contentLoader.item.openClipboardUrl(url)) {
                    clipboardMonitor.acknowledge(sourceText)
                }
            })
        }
    }

    Action {
        id: newDownloadAction
        text: window.t("action.newDownload")
        shortcut: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.addDownload || "Ctrl+N")
            : ""
        enabled: novaApi.connected
        onTriggered: window.openNewDownload()
    }

    Action {
        id: refreshAction
        text: window.t("action.refresh")
        shortcut: "F5"
        onTriggered: {
            if (window.currentPage === "settings") {
                novaApi.refreshEngineManagement()
                novaApi.refreshLogs("", 300)
            } else {
                novaApi.refreshDownloads()
            }
        }
    }

    Action {
        id: settingsAction
        text: window.t("nav.settings")
        shortcut: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.openSettings || "Ctrl+,")
            : ""
        onTriggered: window.currentPage = "settings"
    }

    Action {
        id: checkUpdatesAction
        text: window.t("action.checkUpdates")
        onTriggered: {
            window.currentPage = "settings"
            updaterManager.checkForUpdates(nativeSettings.updateChannel)
        }
    }

    Shortcut { sequence: "Alt+1"; onActivated: window.currentPage = "downloads" }
    Shortcut { sequence: "Alt+2"; onActivated: window.currentPage = "active" }
    Shortcut { sequence: "Alt+3"; onActivated: window.currentPage = "queued" }
    Shortcut { sequence: "Alt+4"; onActivated: window.currentPage = "completed" }
    Shortcut { sequence: "Alt+5"; onActivated: window.currentPage = "failed" }
    Shortcut { sequence: "Ctrl+Shift+M"; onActivated: window.currentPage = "media" }

    Shortcut {
        sequence: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.toggleNotifications || "Ctrl+M")
            : ""
        onActivated: {
            nativeSettings.notificationsEnabled = !nativeSettings.notificationsEnabled
        }
    }

    Shortcut {
        sequence: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.toggleSpeedLimiter || "Ctrl+Shift+L")
            : ""
        onActivated: {
            const advanced = nativeSettings.advancedSettings || ({})
            const enabled = !Boolean(advanced.speedLimiterEnabled)
            nativeSettings.setAdvancedValue("speedLimiterEnabled", enabled)
            novaApi.setGlobalBandwidthLimit(
                enabled ? Number(advanced.speedLimitKbs || 0) : 0
            )
        }
    }

    palette.window: Theme.window
    palette.windowText: Theme.textPrimary
    palette.base: Theme.surface
    palette.alternateBase: Theme.sidebar
    palette.text: Theme.textPrimary
    palette.button: Theme.surface
    palette.buttonText: Theme.textPrimary
    palette.highlight: Theme.accent
    palette.highlightedText: "white"

    Rectangle {
        id: shell
        anchors.fill: parent
        radius: window.visibility === Window.Maximized ? 0 : Theme.radiusLarge
        color: Theme.window
        border.width: window.visibility === Window.Maximized ? 0 : 1
        border.color: Theme.borderStrong
        clip: true

        ColumnLayout {
            anchors.fill: parent
            spacing: 0

            Rectangle {
                id: titleBar
                Layout.fillWidth: true
                Layout.preferredHeight: Theme.titleBarHeight
                color: Theme.sidebar

                MouseArea {
                    anchors.fill: parent
                    z: 0
                    acceptedButtons: Qt.LeftButton
                    onDoubleClicked: window.toggleMaximized()
                    onPressed: mouse => {
                        if (mouse.button === Qt.LeftButton)
                            window.startSystemMove()
                    }
                }

                RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 12
                    anchors.rightMargin: 8
                    spacing: 10
                    z: 1

                    ToolButton {
                        text: "☰"
                        Layout.preferredWidth: 38
                        Layout.preferredHeight: 38
                        Accessible.name: window.t("custom.toggleSidebar")
                        onClicked: nativeSettings.sidebarVisible = !nativeSettings.sidebarVisible
                    }

                    Rectangle {
                        Layout.preferredWidth: 28
                        Layout.preferredHeight: 28
                        radius: 7
                        color: Theme.accent

                        Text {
                            anchors.centerIn: parent
                            text: "N"
                            color: "white"
                            font.pixelSize: Theme.fontMedium
                            font.weight: Font.Bold
                        }
                    }

                    Text {
                        text: window.t("app.name")
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontMedium
                        font.weight: Font.DemiBold
                    }

                    Item { Layout.fillWidth: true }

                    TextField {
                        id: topSearch
                        visible: window.isDownloadsPage()
                        Layout.preferredWidth: Math.min(370, Math.max(240, window.width * 0.25))
                        Layout.preferredHeight: 36
                        placeholderText: window.t("downloads.search")
                        Accessible.name: placeholderText
                        selectByMouse: true
                        LayoutMirroring.enabled: false
                        onTextChanged: window.applyTopSearch(text)

                        background: Rectangle {
                            radius: Theme.radiusMedium
                            color: Theme.surface
                            border.width: parent.activeFocus ? 2 : 1
                            border.color: parent.activeFocus ? Theme.focusRing : Theme.border
                        }

                        leftPadding: 34
                        Text {
                            anchors.left: parent.left
                            anchors.leftMargin: 11
                            anchors.verticalCenter: parent.verticalCenter
                            text: "⌕"
                            color: Theme.textMuted
                            font.pixelSize: Theme.fontBody
                        }
                    }

                    ToolButton {
                        text: "⚙"
                        Layout.preferredWidth: 38
                        Layout.preferredHeight: 38
                        Accessible.name: window.t("custom.open")
                        onClicked: window.customizationOpen = !window.customizationOpen
                    }

                    Rectangle {
                        Layout.preferredWidth: 1
                        Layout.preferredHeight: 24
                        color: Theme.border
                    }

                    ToolButton {
                        text: "−"
                        Layout.preferredWidth: 38
                        Layout.preferredHeight: 38
                        Accessible.name: window.t("common.minimize")
                        onClicked: window.showMinimized()
                    }

                    ToolButton {
                        text: window.visibility === Window.Maximized ? "❐" : "□"
                        Layout.preferredWidth: 38
                        Layout.preferredHeight: 38
                        Accessible.name: window.t("common.maximize")
                        onClicked: window.toggleMaximized()
                    }

                    ToolButton {
                        text: "×"
                        Layout.preferredWidth: 38
                        Layout.preferredHeight: 38
                        Accessible.name: window.t("common.close")
                        onClicked: window.close()
                    }
                }
            }

            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 1
                color: Theme.border
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 0

                NavigationRail {
                    visible: nativeSettings.sidebarVisible
                    Layout.fillHeight: true
                    Layout.preferredWidth: implicitWidth
                    collapsed: nativeSettings.sidebarCollapsed
                    currentPage: window.currentPage
                    activeDownloads: downloadsModel.activeCount
                    onPageSelected: page => window.currentPage = page
                }

                Rectangle {
                    visible: nativeSettings.sidebarVisible
                    Layout.fillHeight: true
                    Layout.preferredWidth: 1
                    color: Theme.border
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    spacing: 0

                    Loader {
                        id: contentLoader
                        Layout.fillWidth: true
                        Layout.fillHeight: true

                        sourceComponent: window.isDownloadsPage()
                            ? downloadsPage
                            : window.currentPage === "queue"
                                ? queuePage
                                : window.currentPage === "batch"
                                    ? batchImportPage
                                    : window.currentPage === "scheduler"
                                        ? schedulerPage
                                        : window.currentPage === "media"
                                            ? mediaDownloaderPage
                                            : window.currentPage === "grabber"
                                                ? linkGrabberPage
                                                : window.currentPage === "settings"
                                                    ? settingsPage
                                                    : placeholderPage

                        onLoaded: {
                            if (item && item.setSearchQuery && topSearch.text.length > 0)
                                item.setSearchQuery(topSearch.text)
                        }
                    }

                    StatusBar {
                        visible: nativeSettings.statusBarVisible
                        Layout.fillWidth: true
                        engineConnected: novaApi.connected
                        engineStatus: novaApi.statusText
                        activeCount: downloadsModel.activeCount
                        totalCount: downloadsModel.totalCount
                        totalSpeed: downloadsModel.totalSpeed
                    }
                }

                Rectangle {
                    visible: window.customizationOpen
                    Layout.fillHeight: true
                    Layout.preferredWidth: 1
                    color: Theme.border
                }

                CustomizationPanel {
                    visible: window.customizationOpen
                    Layout.fillHeight: true
                    Layout.preferredWidth: Theme.customizationWidth
                    settings: nativeSettings
                    onCloseRequested: window.customizationOpen = false
                    onOpenSettingsRequested: {
                        window.currentPage = "settings"
                        window.customizationOpen = false
                    }
                }
            }
        }
    }

    Component {
        id: downloadsPage

        DownloadsPage {
            downloads: downloadsModel
            api: novaApi
            page: window.currentPage
        }
    }

    Component {
        id: queuePage

        QueuePage {
            api: novaApi
            downloads: downloadsModel
        }
    }

    Component {
        id: batchImportPage

        BatchImportPage {
            api: novaApi
            settings: nativeSettings
            desktop: desktopIntegration
        }
    }

    Component {
        id: schedulerPage

        SchedulerPage {
            api: novaApi
        }
    }

    Component {
        id: mediaDownloaderPage

        MediaDownloaderPage {
            api: novaApi
            settings: nativeSettings
            desktop: desktopIntegration
        }
    }

    Component {
        id: linkGrabberPage

        LinkGrabberPage {
            api: novaApi
            settings: nativeSettings
            desktop: desktopIntegration
        }
    }

    Component {
        id: settingsPage

        SettingsPage {
            api: novaApi
            settings: nativeSettings
            tray: trayManager
            desktop: desktopIntegration
            updater: updaterManager
        }
    }

    Connections {
        target: trayManager

        function onShowRequested() {
            window.show()
            window.raise()
            window.requestActivate()
        }
    }

    onClosing: close => {
        if (nativeSettings.closeToTray && trayManager.available && trayManager.enabled) {
            close.accepted = false
            window.hide()
        }
    }

    Component {
        id: placeholderPage

        Item {
            ColumnLayout {
                anchors.centerIn: parent
                spacing: 8

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: window.currentPage.charAt(0).toUpperCase() + window.currentPage.slice(1)
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontTitle
                    font.weight: Font.DemiBold
                }

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: window.t("placeholder.migrating")
                    color: Theme.textMuted
                    font.pixelSize: Math.round(11 * Theme.fontScale)
                }
            }
        }
    }
}
