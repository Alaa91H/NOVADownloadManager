import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

ApplicationWindow {
    id: window

    visible: true
    width: 1280
    height: 780
    minimumWidth: 980
    minimumHeight: 620
    title: "NOVA Download Manager"
    color: Theme.window

    property string currentPage: "downloads"

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
                Layout.fillWidth: true
                Layout.fillHeight: true

                sourceComponent: window.currentPage === "downloads" || window.currentPage === "active"
                                 || window.currentPage === "queued" || window.currentPage === "completed"
                                 || window.currentPage === "failed"
                                 ? downloadsPage
                                 : placeholderPage
            }

            StatusBar {
                Layout.fillWidth: true
                engineConnected: novaApi.connected
                engineStatus: novaApi.statusText
                activeCount: downloadsModel.activeCount
                totalCount: downloadsModel.count
                totalSpeed: downloadsModel.totalSpeed
            }
        }
    }

    Component {
        id: downloadsPage

        DownloadsPage {
            downloads: downloadsModel
            api: novaApi
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
