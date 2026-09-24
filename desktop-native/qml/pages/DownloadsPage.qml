import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var downloads
    required property var api
    required property string page

    property int selectedIndex: -1
    property var selectedItem: ({})
    property string query: ""
    property string pendingDeleteId: ""
    property string pendingDeleteName: ""

    function pageTitle() {
        if (page === "active") return "Active downloads"
        if (page === "queued") return "Queued downloads"
        if (page === "completed") return "Completed downloads"
        if (page === "failed") return "Failed downloads"
        return "Downloads"
    }

    function pageSubtitle() {
        if (page === "active") return "Transfers currently using the NOVA engine"
        if (page === "queued") return "Downloads waiting to start or currently paused"
        if (page === "completed") return "Successfully completed transfers"
        if (page === "failed") return "Transfers that need attention"
        return "Manage active, queued and completed transfers"
    }

    function formatBytes(value) {
        if (!value || value <= 0) return "—"
        if (value >= 1024 * 1024 * 1024)
            return (value / (1024 * 1024 * 1024)).toFixed(2) + " GB"
        if (value >= 1024 * 1024)
            return (value / (1024 * 1024)).toFixed(1) + " MB"
        if (value >= 1024)
            return (value / 1024).toFixed(0) + " KB"
        return value + " B"
    }

    function formatSpeed(value) {
        if (!value || value <= 0) return "—"
        if (value >= 1024 * 1024)
            return (value / (1024 * 1024)).toFixed(1) + " MB/s"
        if (value >= 1024)
            return (value / 1024).toFixed(0) + " KB/s"
        return value + " B/s"
    }

    function formatEta(value) {
        if (!value || value <= 0) return "—"
        if (value < 60) return value + "s"
        if (value < 3600) return Math.floor(value / 60) + "m " + (value % 60) + "s"
        return Math.floor(value / 3600) + "h " + Math.floor((value % 3600) / 60) + "m"
    }

    function clearSelection() {
        selectedIndex = -1
        selectedItem = ({})
    }

    function updateSelection() {
        if (selectedIndex < 0 || selectedIndex >= downloads.count) {
            clearSelection()
            return
        }
        selectedItem = downloads.itemAt(selectedIndex)
    }

    function applyPageFilter() {
        clearSelection()
        downloads.filterState = page
    }

    function requestDelete() {
        if (selectedIndex < 0)
            return

        updateSelection()
        pendingDeleteId = downloads.taskIdAt(selectedIndex)
        pendingDeleteName = selectedItem.name || "Selected download"
        if (pendingDeleteId.length > 0)
            deleteDialog.open()
    }

    Component.onCompleted: {
        downloads.filterState = page
        downloads.searchQuery = query
    }

    onPageChanged: applyPageFilter()

    Connections {
        target: root.downloads

        function onSummaryChanged() {
            root.updateSelection()
        }

        function onFilterChanged() {
            root.clearSelection()
        }
    }

    Shortcut {
        sequence: StandardKey.New
        enabled: root.api.connected && !addDownloadDialog.visible
        onActivated: addDownloadDialog.openNew()
    }

    Shortcut {
        sequence: StandardKey.Find
        enabled: !addDownloadDialog.visible
        onActivated: searchField.forceActiveFocus()
    }

    Shortcut {
        sequence: "F5"
        onActivated: root.api.refreshDownloads()
    }

    Shortcut {
        sequence: "Escape"
        enabled: root.selectedIndex >= 0 && !addDownloadDialog.visible && !deleteDialog.visible
        onActivated: root.clearSelection()
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Layout.preferredHeight: 68
            Layout.leftMargin: 16
            Layout.rightMargin: 16
            spacing: 12

            ColumnLayout {
                spacing: 2

                Text {
                    text: root.pageTitle()
                    color: Theme.textPrimary
                    font.pixelSize: 21
                    font.weight: Font.DemiBold
                }

                Text {
                    text: root.pageSubtitle()
                    color: Theme.textMuted
                    font.pixelSize: 10
                }
            }

            Item { Layout.fillWidth: true }

            Text {
                text: root.downloads.count + (root.downloads.count === 1 ? " item" : " items")
                color: Theme.textMuted
                font.pixelSize: 10
            }

            TextField {
                id: searchField
                Layout.preferredWidth: 280
                placeholderText: "Search name, URL, path, engine…"
                selectByMouse: true
                onTextChanged: {
                    root.query = text
                    root.downloads.searchQuery = text
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 34
            Layout.leftMargin: 14
            Layout.rightMargin: 14
            visible: !root.api.connected
            radius: Theme.radiusMedium
            color: Qt.rgba(0.82, 0.60, 0.13, 0.10)
            border.color: Theme.warning

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 10
                anchors.rightMargin: 10
                spacing: 8

                Rectangle {
                    width: 7
                    height: 7
                    radius: 4
                    color: Theme.warning
                }

                Text {
                    Layout.fillWidth: true
                    text: "NOVA engine is unavailable. Existing data remains visible, but download actions are disabled until the engine reconnects."
                    color: Theme.textSecondary
                    font.pixelSize: 10
                    elide: Text.ElideRight
                }

                Button {
                    text: "Retry"
                    flat: true
                    onClicked: {
                        root.api.checkHealth()
                        root.api.refreshDownloads()
                    }
                }
            }
        }

        CommandBar {
            Layout.fillWidth: true
            hasSelection: root.selectedIndex >= 0
            engineConnected: root.api.connected
            onNewDownloadRequested: addDownloadDialog.openNew()
            onRefreshRequested: root.api.refreshDownloads()
            onPauseRequested: {
                if (root.selectedIndex >= 0)
                    root.api.pauseDownload(root.downloads.taskIdAt(root.selectedIndex))
            }
            onResumeRequested: {
                if (root.selectedIndex >= 0)
                    root.api.resumeDownload(root.downloads.taskIdAt(root.selectedIndex))
            }
            onDeleteRequested: root.requestDelete()
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.leftMargin: 14
            Layout.rightMargin: 14
            Layout.bottomMargin: 12
            spacing: 10

            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                color: Theme.surface
                border.color: Theme.border
                radius: Theme.radiusMedium
                clip: true

                ColumnLayout {
                    anchors.fill: parent
                    spacing: 0

                    Rectangle {
                        Layout.fillWidth: true
                        Layout.preferredHeight: 34
                        color: Theme.sidebar

                        RowLayout {
                            anchors.fill: parent
                            anchors.leftMargin: 12
                            anchors.rightMargin: 12
                            spacing: 10

                            Text { Layout.fillWidth: true; text: "Name"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                            Text { Layout.preferredWidth: 88; text: "Size"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                            Text { Layout.preferredWidth: 190; text: "Progress"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                            Text { Layout.preferredWidth: 90; text: "Speed"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                            Text { Layout.preferredWidth: 70; text: "ETA"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                            Text { Layout.preferredWidth: 100; text: "Status"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                        }
                    }

                    ListView {
                        id: list
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        boundsBehavior: Flickable.StopAtBounds
                        model: root.downloads
                        ScrollBar.vertical: ScrollBar {}

                        delegate: Rectangle {
                            required property int index
                            required property string taskId
                            required property string name
                            required property string status
                            required property double sizeBytes
                            required property double progress
                            required property double speedBytesPerSec
                            required property int etaSeconds

                            width: list.width
                            height: Theme.rowHeight
                            color: root.selectedIndex === index
                                ? Theme.surfaceSelected
                                : mouse.containsMouse ? Theme.surfaceHover : "transparent"

                            Rectangle {
                                anchors.bottom: parent.bottom
                                width: parent.width
                                height: 1
                                color: Theme.border
                                opacity: 0.65
                            }

                            RowLayout {
                                anchors.fill: parent
                                anchors.leftMargin: 12
                                anchors.rightMargin: 12
                                spacing: 10

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 1

                                    Text {
                                        Layout.fillWidth: true
                                        text: name || "Unnamed download"
                                        color: Theme.textPrimary
                                        font.pixelSize: 11
                                        font.weight: Font.Medium
                                        elide: Text.ElideMiddle
                                    }

                                    Text {
                                        Layout.fillWidth: true
                                        text: taskId
                                        color: Theme.textMuted
                                        font.pixelSize: 8
                                        elide: Text.ElideRight
                                        visible: taskId.length > 0
                                    }
                                }

                                Text {
                                    Layout.preferredWidth: 88
                                    text: root.formatBytes(sizeBytes)
                                    color: Theme.textSecondary
                                    font.pixelSize: 10
                                    font.family: "monospace"
                                }

                                RowLayout {
                                    Layout.preferredWidth: 190
                                    spacing: 8

                                    ProgressBar {
                                        Layout.fillWidth: true
                                        from: 0
                                        to: 1
                                        value: progress
                                    }

                                    Text {
                                        Layout.preferredWidth: 38
                                        text: Math.round(progress * 100) + "%"
                                        color: Theme.textSecondary
                                        font.pixelSize: 10
                                        font.family: "monospace"
                                        horizontalAlignment: Text.AlignRight
                                    }
                                }

                                Text {
                                    Layout.preferredWidth: 90
                                    text: root.formatSpeed(speedBytesPerSec)
                                    color: speedBytesPerSec > 0 ? Theme.textPrimary : Theme.textMuted
                                    font.pixelSize: 10
                                    font.family: "monospace"
                                }

                                Text {
                                    Layout.preferredWidth: 70
                                    text: root.formatEta(etaSeconds)
                                    color: Theme.textSecondary
                                    font.pixelSize: 10
                                    font.family: "monospace"
                                }

                                Text {
                                    Layout.preferredWidth: 100
                                    text: status
                                    color: status === "completed"
                                        ? Theme.success
                                        : status === "error" || status === "failed" ? Theme.danger
                                        : status === "paused" ? Theme.warning
                                        : Theme.textSecondary
                                    font.pixelSize: 10
                                    font.weight: Font.DemiBold
                                }
                            }

                            MouseArea {
                                id: mouse
                                anchors.fill: parent
                                hoverEnabled: true
                                acceptedButtons: Qt.LeftButton | Qt.RightButton
                                onClicked: {
                                    root.selectedIndex = index
                                    root.updateSelection()
                                }
                            }
                        }

                        footer: Item { width: 1; height: 4 }
                    }
                }

                ColumnLayout {
                    anchors.centerIn: parent
                    spacing: 8
                    visible: list.count === 0

                    Text {
                        Layout.alignment: Qt.AlignHCenter
                        text: root.query.length > 0
                            ? "No matching downloads"
                            : root.page === "downloads" ? "No downloads yet" : "Nothing in this view"
                        color: Theme.textPrimary
                        font.pixelSize: 16
                        font.weight: Font.DemiBold
                    }

                    Text {
                        Layout.alignment: Qt.AlignHCenter
                        text: root.query.length > 0
                            ? "Try a different search."
                            : root.api.connected
                                ? "Start a new download or switch to another category."
                                : "Start the NOVA engine to load your downloads."
                        color: Theme.textMuted
                        font.pixelSize: 11
                    }

                    Button {
                        Layout.alignment: Qt.AlignHCenter
                        visible: root.query.length === 0 && root.api.connected
                        text: "+ New download"
                        onClicked: addDownloadDialog.openNew()
                    }
                }
            }

            DownloadDetailsPanel {
                Layout.fillHeight: true
                Layout.preferredWidth: root.selectedIndex >= 0 ? Theme.detailsWidth : 0
                visible: root.selectedIndex >= 0
                item: root.selectedItem
                onCloseRequested: root.clearSelection()
            }
        }
    }

    AddDownloadDialog {
        id: addDownloadDialog
        api: root.api
        parent: Overlay.overlay
        x: parent ? Math.round((parent.width - width) / 2) : 0
        y: parent ? Math.round((parent.height - height) / 2) : 0
    }

    ConfirmDeleteDialog {
        id: deleteDialog
        downloadName: root.pendingDeleteName
        parent: Overlay.overlay
        x: parent ? Math.round((parent.width - width) / 2) : 0
        y: parent ? Math.round((parent.height - height) / 2) : 0

        onConfirmed: {
            if (root.pendingDeleteId.length > 0)
                root.api.deleteDownload(root.pendingDeleteId)
            root.pendingDeleteId = ""
            root.pendingDeleteName = ""
            root.clearSelection()
        }
    }
}
