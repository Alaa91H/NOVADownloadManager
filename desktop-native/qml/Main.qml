import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

ApplicationWindow {
    id: window

    visible: !nativeSettings.startMinimized || !trayManager.enabled
    width: 1360
    height: 820
    minimumWidth: 1040
    minimumHeight: 660
    title: t("app.name")
    color: Theme.window

    property string currentPage: "downloads"
    property string languageToken: i18n.language

    LayoutMirroring.enabled: i18n.rtl
    LayoutMirroring.childrenInherit: true

    function t(key) {
        const token = window.languageToken
        return i18n.translate(key)
    }

    function syncUiPreferences() {
        i18n.setLanguage(nativeSettings.uiLanguage)

        const mode = nativeSettings.appearanceMode
        Theme.darkMode = mode === "dark"
            || (mode === "system" && appearanceManager.systemDark)
        Theme.highContrast = nativeSettings.highContrast
        Theme.reducedMotion = nativeSettings.reducedMotion
        Theme.fontScale = nativeSettings.fontScale
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

    function openNewDownload() {
        window.currentPage = "downloads"
        Qt.callLater(function() {
            if (contentLoader.item && contentLoader.item.openNewDownload)
                contentLoader.item.openNewDownload()
        })
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

    menuBar: MenuBar {
        Menu {
            title: window.t("menu.file")
            MenuItem { action: newDownloadAction }
            MenuItem {
                text: window.t("nav.batch")
                shortcut: nativeSettings.shortcutsEnabled
                    ? String(nativeSettings.shortcutBindings.batchDownload || "Ctrl+Shift+N")
                    : ""
                onTriggered: window.currentPage = "batch"
            }
            MenuSeparator {}
            MenuItem {
                text: window.t("action.quit")
                shortcut: StandardKey.Quit
                onTriggered: Qt.quit()
            }
        }

        Menu {
            title: window.t("menu.view")
            MenuItem { text: window.t("nav.downloads"); shortcut: "Alt+1"; onTriggered: window.currentPage = "downloads" }
            MenuItem { text: window.t("nav.active"); shortcut: "Alt+2"; onTriggered: window.currentPage = "active" }
            MenuItem { text: window.t("nav.queued"); shortcut: "Alt+3"; onTriggered: window.currentPage = "queued" }
            MenuItem { text: window.t("nav.completed"); shortcut: "Alt+4"; onTriggered: window.currentPage = "completed" }
            MenuItem { text: window.t("nav.failed"); shortcut: "Alt+5"; onTriggered: window.currentPage = "failed" }
            MenuSeparator {}
            MenuItem { action: refreshAction }
        }

        Menu {
            title: window.t("menu.tools")
            MenuItem { text: window.t("nav.queue"); onTriggered: window.currentPage = "queue" }
            MenuItem {
                text: window.t("nav.scheduler")
                shortcut: nativeSettings.shortcutsEnabled
                    ? String(nativeSettings.shortcutBindings.openScheduler || "Ctrl+L")
                    : ""
                onTriggered: window.currentPage = "scheduler"
            }
            MenuItem { text: window.t("nav.media"); shortcut: "Ctrl+Shift+M"; onTriggered: window.currentPage = "media" }
            MenuItem { text: window.t("nav.grabber"); shortcut: "Ctrl+L"; onTriggered: window.currentPage = "grabber" }
            MenuSeparator {}
            MenuItem { action: settingsAction }
        }

        Menu {
            title: window.t("menu.help")
            MenuItem { action: checkUpdatesAction }
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

    RowLayout {
        anchors.fill: parent
        spacing: 0

        NavigationRail {
            Layout.fillHeight: true
            currentPage: window.currentPage
            activeDownloads: downloadsModel.activeCount
            onPageSelected: page => window.currentPage = page
        }

        Rectangle {
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

                sourceComponent: window.currentPage === "downloads" || window.currentPage === "active"
                                 || window.currentPage === "queued" || window.currentPage === "completed"
                                 || window.currentPage === "failed"
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
            }

            StatusBar {
                Layout.fillWidth: true
                engineConnected: novaApi.connected
                engineStatus: novaApi.statusText
                activeCount: downloadsModel.activeCount
                totalCount: downloadsModel.totalCount
                totalSpeed: downloadsModel.totalSpeed
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
                    font.pixelSize: 22
                    font.weight: Font.DemiBold
                }

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: window.t("placeholder.migrating")
                    color: Theme.textMuted
                    font.pixelSize: 11
                }
            }
        }
    }
}
