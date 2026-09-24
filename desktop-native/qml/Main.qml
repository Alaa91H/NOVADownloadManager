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
    title: "NOVA Download Manager"
    color: Theme.window

    property string currentPage: "downloads"

    function openNewDownload() {
        window.currentPage = "downloads"
        Qt.callLater(function() {
            if (contentLoader.item && contentLoader.item.openNewDownload)
                contentLoader.item.openNewDownload()
        })
    }

    Action {
        id: newDownloadAction
        text: "New Download"
        shortcut: StandardKey.New
        enabled: novaApi.connected
        onTriggered: window.openNewDownload()
    }

    Action {
        id: refreshAction
        text: "Refresh"
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
        text: "Settings"
        shortcut: "Ctrl+,"
        onTriggered: window.currentPage = "settings"
    }

    Action {
        id: checkUpdatesAction
        text: "Check for Updates"
        onTriggered: {
            window.currentPage = "settings"
            updaterManager.checkForUpdates(nativeSettings.updateChannel)
        }
    }

    menuBar: MenuBar {
        Menu {
            title: "File"
            MenuItem { action: newDownloadAction }
            MenuItem {
                text: "Batch Import"
                shortcut: "Ctrl+Shift+B"
                onTriggered: window.currentPage = "batch"
            }
            MenuSeparator {}
            MenuItem {
                text: "Quit"
                shortcut: StandardKey.Quit
                onTriggered: Qt.quit()
            }
        }

        Menu {
            title: "View"
            MenuItem { text: "Downloads"; shortcut: "Alt+1"; onTriggered: window.currentPage = "downloads" }
            MenuItem { text: "Active"; shortcut: "Alt+2"; onTriggered: window.currentPage = "active" }
            MenuItem { text: "Queued"; shortcut: "Alt+3"; onTriggered: window.currentPage = "queued" }
            MenuItem { text: "Completed"; shortcut: "Alt+4"; onTriggered: window.currentPage = "completed" }
            MenuItem { text: "Failed"; shortcut: "Alt+5"; onTriggered: window.currentPage = "failed" }
            MenuSeparator {}
            MenuItem { action: refreshAction }
        }

        Menu {
            title: "Tools"
            MenuItem { text: "Queue Manager"; onTriggered: window.currentPage = "queue" }
            MenuItem { text: "Scheduler"; onTriggered: window.currentPage = "scheduler" }
            MenuItem { text: "Media Downloader"; shortcut: "Ctrl+Shift+M"; onTriggered: window.currentPage = "media" }
            MenuItem { text: "Link Grabber"; shortcut: "Ctrl+L"; onTriggered: window.currentPage = "grabber" }
            MenuSeparator {}
            MenuItem { action: settingsAction }
        }

        Menu {
            title: "Help"
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
                    text: "This workspace will be migrated independently from the legacy UI."
                    color: Theme.textMuted
                    font.pixelSize: 11
                }
            }
        }
    }
}
