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
    property string pendingRedownloadId: ""
    property string pendingRedownloadName: ""
    property bool pendingRedownloadRetryMode: false
    property string noticeText: ""
    property bool noticeIsError: false
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function openNewDownload() {
        addDownloadDialog.openNew()
    }

    function pageTitle() {
        if (page === "active") return root.t("downloads.activeTitle")
        if (page === "queued") return root.t("downloads.queuedTitle")
        if (page === "completed") return root.t("downloads.completedTitle")
        if (page === "failed") return root.t("downloads.failedTitle")
        return root.t("downloads.title")
    }

    function pageSubtitle() {
        if (page === "active") return root.t("downloads.activeSubtitle")
        if (page === "queued") return root.t("downloads.queuedSubtitle")
        if (page === "completed") return root.t("downloads.completedSubtitle")
        if (page === "failed") return root.t("downloads.failedSubtitle")
        return root.t("downloads.subtitle")
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

    function selectRow(index) {
        selectedIndex = index
        updateSelection()
    }

    function applyPageFilter() {
        clearSelection()
        downloads.filterState = page
    }

    function showNotice(message, isError) {
        noticeText = message
        noticeIsError = isError
        noticeTimer.restart()
    }

    function selectedTaskId() {
        return selectedIndex >= 0 ? downloads.taskIdAt(selectedIndex) : ""
    }

    function isRetryStatus(status) {
        const normalized = (status || "").toLowerCase()
        return normalized === "failed"
            || normalized === "error"
            || normalized === "interrupted"
    }

    function canPauseStatus(status) {
        const normalized = (status || "").toLowerCase()
        return normalized === "queued"
            || normalized === "preparing"
            || normalized === "probing"
            || normalized === "downloading"
            || normalized === "retrying"
            || normalized === "recovering"
            || normalized === "failed"
            || normalized === "error"
            || normalized === "interrupted"
    }

    function canResumeStatus(status) {
        const normalized = (status || "").toLowerCase()
        return normalized === "paused"
            || normalized === "queued"
            || normalized === "failed"
            || normalized === "error"
            || normalized === "interrupted"
    }

    function requestDelete() {
        if (selectedIndex < 0)
            return

        updateSelection()
        pendingDeleteId = selectedTaskId()
        pendingDeleteName = selectedItem.name || root.t("common.selectedDownload")
        if (pendingDeleteId.length > 0)
            deleteDialog.open()
    }

    function requestRedownload() {
        if (selectedIndex < 0 || !api.connected)
            return

        updateSelection()
        pendingRedownloadId = selectedTaskId()
        pendingRedownloadName = selectedItem.name || root.t("common.selectedDownload")
        pendingRedownloadRetryMode = isRetryStatus(selectedItem.status)
        if (pendingRedownloadId.length > 0)
            redownloadDialog.open()
    }

    function openSelectedFile() {
        updateSelection()
        if ((selectedItem.savePath || "").length > 0)
            desktopIntegration.openFile(selectedItem.savePath)
    }

    function revealSelectedFile() {
        updateSelection()
        if ((selectedItem.savePath || "").length > 0)
            desktopIntegration.revealInFolder(selectedItem.savePath)
    }

    function showSelectedProperties() {
        updateSelection()
        if (selectedIndex >= 0)
            propertiesDialog.openFor(selectedItem)
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

    Connections {
        target: root.api

        function onRequestFailed(message) {
            root.showNotice(message, true)
        }

        function onTaskActionCompleted(action, taskId) {
            if (action === "redownload")
                root.showNotice(root.t("downloads.restarted"), false)
            else if (action === "pause")
                root.showNotice(root.t("downloads.paused"), false)
            else if (action === "resume")
                root.showNotice(root.t("downloads.resumed"), false)
            else if (action === "delete")
                root.showNotice(root.t("downloads.removed"), false)
        }

        function onDownloadUpdated(taskId) {
            root.showNotice(root.t("downloads.updated"), false)
        }
    }

    Connections {
        target: desktopIntegration

        function onOperationFailed(action, message) {
            root.showNotice(message, true)
        }
    }

    Timer {
        id: noticeTimer
        interval: 4500
        onTriggered: root.noticeText = ""
    }

    Shortcut {
        sequence: StandardKey.Find
        enabled: !addDownloadDialog.visible
        onActivated: searchField.forceActiveFocus()
    }

    Shortcut {
        sequence: "Delete"
        enabled: root.selectedIndex >= 0
            && root.api.connected
            && !deleteDialog.visible
            && !redownloadDialog.visible
        onActivated: root.requestDelete()
    }

    Shortcut {
        sequence: "Escape"
        enabled: root.selectedIndex >= 0
            && !addDownloadDialog.visible
            && !deleteDialog.visible
            && !redownloadDialog.visible
            && !propertiesDialog.visible
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
                    font.pixelSize: Theme.fontTitle
                    font.weight: Font.DemiBold
                }

                Text {
                    text: root.pageSubtitle()
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontSmall
                }
            }

            Item { Layout.fillWidth: true }

            Text {
                text: root.downloads.count + " " + (root.downloads.count === 1 ? root.t("downloads.item") : root.t("downloads.items"))
                color: Theme.textMuted
                font.pixelSize: Theme.fontSmall
            }

            TextField {
                id: searchField
                Layout.preferredWidth: 280
                placeholderText: root.t("downloads.search")
                selectByMouse: true
                Accessible.name: root.t("downloads.search")
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
                    text: root.t("downloads.engineUnavailable")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                    elide: Text.ElideRight
                }

                Button {
                    text: root.t("downloads.retryConnection")
                    flat: true
                    onClicked: {
                        root.api.checkHealth()
                        root.api.refreshDownloads()
                    }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 34
            Layout.leftMargin: 14
            Layout.rightMargin: 14
            visible: root.noticeText.length > 0
            radius: Theme.radiusMedium
            color: root.noticeIsError
                ? Qt.rgba(0.97, 0.32, 0.29, 0.10)
                : Qt.rgba(0.25, 0.73, 0.31, 0.10)
            border.color: root.noticeIsError ? Theme.danger : Theme.success

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 10
                anchors.rightMargin: 8

                Text {
                    Layout.fillWidth: true
                    text: root.noticeText
                    color: root.noticeIsError ? Theme.danger : Theme.success
                    font.pixelSize: Theme.fontSmall
                    elide: Text.ElideRight
                }

                ToolButton {
                    text: "×"
                    onClicked: root.noticeText = ""
                }
            }
        }

        CommandBar {
            Layout.fillWidth: true
            hasSelection: root.selectedIndex >= 0
            engineConnected: root.api.connected
            selectedStatus: root.selectedItem.status || ""
            canPauseSelection: root.canPauseStatus(root.selectedItem.status)
            canResumeSelection: root.canResumeStatus(root.selectedItem.status)
            hasSavePath: (root.selectedItem.savePath || "").length > 0

            onNewDownloadRequested: addDownloadDialog.openNew()
            onRefreshRequested: root.api.refreshDownloads()
            onPauseRequested: {
                const id = root.selectedTaskId()
                if (id.length > 0)
                    root.api.pauseDownload(id)
            }
            onResumeRequested: {
                const id = root.selectedTaskId()
                if (id.length > 0)
                    root.api.resumeDownload(id)
            }
            onRedownloadRequested: root.requestRedownload()
            onOpenFileRequested: root.openSelectedFile()
            onOpenFolderRequested: root.revealSelectedFile()
            onPropertiesRequested: root.showSelectedProperties()
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

                            Text { Layout.fillWidth: true; text: root.t("common.name"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall; font.weight: Font.DemiBold }
                            Text { Layout.preferredWidth: 88; text: root.t("common.size"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall; font.weight: Font.DemiBold }
                            Text { Layout.preferredWidth: 190; text: root.t("common.progress"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall; font.weight: Font.DemiBold }
                            Text { Layout.preferredWidth: 90; text: root.t("common.speed"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall; font.weight: Font.DemiBold }
                            Text { Layout.preferredWidth: 70; text: root.t("common.eta"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall; font.weight: Font.DemiBold }
                            Text { Layout.preferredWidth: 100; text: root.t("common.status"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall; font.weight: Font.DemiBold }
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
                            required property string savePath

                            width: list.width
                            height: Theme.rowHeight
                            Accessible.name: name || root.t("common.unnamedDownload")
                            Accessible.description: (status || "") + " · " + Math.round(progress * 100) + "%"
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
                                        text: name || root.t("common.unnamedDownload")
                                        color: Theme.textPrimary
                                        font.pixelSize: Math.round(11 * Theme.fontScale)
                                        font.weight: Font.Medium
                                        elide: Text.ElideMiddle
                                    }

                                    Text {
                                        Layout.fillWidth: true
                                        text: taskId
                                        color: Theme.textMuted
                                        font.pixelSize: Math.max(8, Theme.fontTiny - 1)
                                        elide: Text.ElideRight
                                        visible: taskId.length > 0
                                    }
                                }

                                Text {
                                    Layout.preferredWidth: 88
                                    text: root.formatBytes(sizeBytes)
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
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
                                        font.pixelSize: Theme.fontSmall
                                        font.family: "monospace"
                                        horizontalAlignment: Text.AlignRight
                                    }
                                }

                                Text {
                                    Layout.preferredWidth: 90
                                    text: root.formatSpeed(speedBytesPerSec)
                                    color: speedBytesPerSec > 0 ? Theme.textPrimary : Theme.textMuted
                                    font.pixelSize: Theme.fontSmall
                                    font.family: "monospace"
                                }

                                Text {
                                    Layout.preferredWidth: 70
                                    text: root.formatEta(etaSeconds)
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
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
                                    font.pixelSize: Theme.fontSmall
                                    font.weight: Font.DemiBold
                                }
                            }

                            Menu {
                                id: rowMenu

                                MenuItem {
                                    text: root.t("downloads.openFile")
                                    enabled: status === "completed" && savePath.length > 0
                                    onTriggered: {
                                        root.selectRow(index)
                                        root.openSelectedFile()
                                    }
                                }

                                MenuItem {
                                    text: root.t("downloads.showFolder")
                                    enabled: savePath.length > 0
                                    onTriggered: {
                                        root.selectRow(index)
                                        root.revealSelectedFile()
                                    }
                                }

                                MenuItem {
                                    text: root.t("action.properties")
                                    onTriggered: {
                                        root.selectRow(index)
                                        root.showSelectedProperties()
                                    }
                                }

                                MenuSeparator {}

                                MenuItem {
                                    text: root.t("action.resume")
                                    enabled: root.api.connected && root.canResumeStatus(status)
                                    onTriggered: {
                                        root.selectRow(index)
                                        root.api.resumeDownload(taskId)
                                    }
                                }

                                MenuItem {
                                    text: root.t("action.pause")
                                    enabled: root.api.connected && root.canPauseStatus(status)
                                    onTriggered: {
                                        root.selectRow(index)
                                        root.api.pauseDownload(taskId)
                                    }
                                }

                                MenuItem {
                                    text: root.isRetryStatus(status) ? "Retry from beginning" : "Redownload from beginning"
                                    enabled: root.api.connected
                                    onTriggered: {
                                        root.selectRow(index)
                                        root.requestRedownload()
                                    }
                                }

                                MenuSeparator {}

                                MenuItem {
                                    text: root.t("action.delete")
                                    enabled: root.api.connected
                                    onTriggered: {
                                        root.selectRow(index)
                                        root.requestDelete()
                                    }
                                }
                            }

                            MouseArea {
                                id: mouse
                                anchors.fill: parent
                                hoverEnabled: true
                                acceptedButtons: Qt.LeftButton | Qt.RightButton

                                onClicked: mouseEvent => {
                                    root.selectRow(index)
                                    if (mouseEvent.button === Qt.RightButton)
                                        rowMenu.popup()
                                }

                                onDoubleClicked: {
                                    root.selectRow(index)
                                    if (status === "completed" && savePath.length > 0)
                                        root.openSelectedFile()
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
                            ? root.t("downloads.trySearch")
                            : root.api.connected
                                ? root.t("downloads.startOrSwitch")
                                : root.t("downloads.startEngine")
                        color: Theme.textMuted
                        font.pixelSize: Math.round(11 * Theme.fontScale)
                    }

                    Button {
                        Layout.alignment: Qt.AlignHCenter
                        visible: root.query.length === 0 && root.api.connected
                        text: "+ " + root.t("action.newDownload")
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
                onOpenFileRequested: root.openSelectedFile()
                onOpenFolderRequested: root.revealSelectedFile()
                onPropertiesRequested: root.showSelectedProperties()
            }
        }
    }

    AddDownloadDialog {
        id: addDownloadDialog
        api: root.api
        desktop: desktopIntegration
        settings: nativeSettings
        parent: Overlay.overlay
        x: parent ? Math.round((parent.width - width) / 2) : 0
        y: parent ? Math.round((parent.height - height) / 2) : 0
    }

    DownloadPropertiesDialog {
        id: propertiesDialog
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

    ConfirmRedownloadDialog {
        id: redownloadDialog
        downloadName: root.pendingRedownloadName
        retryMode: root.pendingRedownloadRetryMode
        parent: Overlay.overlay
        x: parent ? Math.round((parent.width - width) / 2) : 0
        y: parent ? Math.round((parent.height - height) / 2) : 0

        onConfirmed: {
            if (root.pendingRedownloadId.length > 0)
                root.api.redownloadDownload(root.pendingRedownloadId)
            root.pendingRedownloadId = ""
            root.pendingRedownloadName = ""
            root.pendingRedownloadRetryMode = false
        }
    }
}
