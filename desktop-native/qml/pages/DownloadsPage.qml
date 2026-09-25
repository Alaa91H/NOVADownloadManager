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
    property var pendingDeleteIds: []
    property bool pendingDeleteCompleted: false
    property string pendingDeleteName: ""
    property bool allVisibleSelected: false
    property string pendingRedownloadId: ""
    property string pendingRedownloadName: ""
    property bool pendingRedownloadRetryMode: false
    property string noticeText: ""
    property bool noticeIsError: false
    signal focusSearchRequested()
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function columnVisible(key) {
        if (key === "name")
            return true
        const columns = nativeSettings.downloadColumns
        for (let i = 0; i < columns.length; ++i) {
            if (columns[i] === key)
                return true
        }
        return false
    }

    function toggleColumn(key) {
        if (key === "name")
            return

        const columns = []
        const current = nativeSettings.downloadColumns
        let found = false
        for (let i = 0; i < current.length; ++i) {
            if (current[i] === key) {
                found = true
                continue
            }
            columns.push(current[i])
        }
        if (!found)
            columns.push(key)
        nativeSettings.downloadColumns = columns
    }

    function resetColumns() {
        nativeSettings.downloadColumns = [
            "name", "size", "progress", "speed", "eta", "status"
        ]
    }

    function requestSort(key) {
        if (downloads.sortKey === key) {
            downloads.sortAscending = !downloads.sortAscending
        } else {
            downloads.sortKey = key
            downloads.sortAscending = true
        }
        nativeSettings.downloadSortKey = downloads.sortKey
        nativeSettings.downloadSortAscending = downloads.sortAscending
        clearSelection()
    }

    function sortIndicator(key) {
        if (downloads.sortKey !== key)
            return ""
        return downloads.sortAscending ? " ↑" : " ↓"
    }

    function applyPresentationSettings() {
        downloads.sortKey = nativeSettings.downloadSortKey
        downloads.sortAscending = nativeSettings.downloadSortAscending
    }

    function openNewDownload() {
        addDownloadDialog.openNew()
    }

    function setSearchQuery(value) {
        query = value
        downloads.searchQuery = value
    }

    function fileGlyph(fileName, fileType, category) {
        const type = String(fileType || category || "").toLowerCase()
        const nameValue = String(fileName || "").toLowerCase()
        if (type.indexOf("video") >= 0 || /\.(mp4|mkv|webm|avi|mov)$/.test(nameValue))
            return "▶"
        if (type.indexOf("audio") >= 0 || /\.(mp3|flac|wav|m4a|ogg)$/.test(nameValue))
            return "♪"
        if (type.indexOf("image") >= 0 || /\.(png|jpe?g|webp|gif|bmp)$/.test(nameValue))
            return "▧"
        if (/\.pdf$/.test(nameValue))
            return "PDF"
        if (/\.(zip|rar|7z|tar|gz)$/.test(nameValue))
            return "ZIP"
        if (/\.(exe|msi|dmg|pkg|appimage|iso)$/.test(nameValue))
            return "◆"
        return "□"
    }

    function openClipboardUrl(url) {
        if (addDownloadDialog.visible
            || deleteDialog.visible
            || redownloadDialog.visible
            || propertiesDialog.visible) {
            return false
        }

        addDownloadDialog.openForUrl(url)
        return true
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

    function formatElapsed(value) {
        if (value === undefined || value === null || value < 0) return "—"
        if (value < 60) return value + "s"
        if (value < 3600) return Math.floor(value / 60) + "m " + (value % 60) + "s"
        return Math.floor(value / 3600) + "h " + Math.floor((value % 3600) / 60) + "m"
    }

    function priorityLabel(queueId) {
        const normalized = (queueId || "").toLowerCase()
        if (normalized === "fast") return root.t("downloads.priorityHigh")
        if (normalized === "night") return root.t("downloads.priorityLow")
        return root.t("downloads.priorityNormal")
    }

    function statusLabel(value) {
        const normalized = String(value || "").toLowerCase()
        if (normalized === "downloading") return root.t("status.downloading")
        if (normalized === "paused") return root.t("status.paused")
        if (normalized === "queued") return root.t("status.queued")
        if (normalized === "completed") return root.t("status.completed")
        if (normalized === "failed" || normalized === "error" || normalized === "interrupted")
            return root.t("status.failed")
        if (normalized === "preparing" || normalized === "probing")
            return root.t("status.preparing")
        if (normalized === "retrying" || normalized === "recovering")
            return root.t("status.retrying")
        if (normalized === "verifying" || normalized === "finalizing")
            return root.t("status.verifying")
        return value || root.t("common.unknown")
    }

    function smartCategoryLabel(fileType, category) {
        const value = (fileType || category || "").trim()
        return value.length > 0 ? value : "—"
    }

    function tableContentWidth() {
        let width = 240
        const widths = {
            size: 88,
            progress: 190,
            speed: 90,
            eta: 70,
            elapsed: 80,
            dateAdded: 130,
            status: 100,
            retries: 72,
            connections: 96,
            crc32: 90,
            priority: 90,
            completedDate: 130,
            sourceUrl: 200,
            smartCategory: 120
        }
        for (const key in widths) {
            if (root.columnVisible(key))
                width += widths[key] + 10
        }
        return Math.max(720, width + 24)
    }

    function clearSelection() {
        selectedIndex = -1
        selectedItem = ({})
        allVisibleSelected = false
    }

    function updateSelection() {
        if (selectedIndex < 0 || selectedIndex >= downloads.count) {
            clearSelection()
            return
        }
        selectedItem = downloads.itemAt(selectedIndex)
    }

    function selectRow(index) {
        allVisibleSelected = false
        selectedIndex = index
        if (list.currentIndex !== index)
            list.currentIndex = index
        updateSelection()
    }

    function selectAllVisible() {
        selectedIndex = -1
        selectedItem = ({})
        allVisibleSelected = downloads.count > 0
    }

    function visibleTaskIds(predicate) {
        const ids = []
        for (let i = 0; i < downloads.count; ++i) {
            const item = downloads.itemAt(i)
            if (!predicate || predicate(item))
                ids.push(String(item.taskId || ""))
        }
        return ids.filter(id => id.length > 0)
    }

    function resumeSelectedShortcut() {
        if (allVisibleSelected) {
            const ids = visibleTaskIds(item => canResumeStatus(item.status))
            for (let i = 0; i < ids.length; ++i)
                api.resumeDownload(ids[i])
            return
        }
        const id = selectedTaskId()
        if (id.length > 0 && canResumeStatus(selectedItem.status))
            api.resumeDownload(id)
    }

    function pauseSelectedShortcut() {
        if (allVisibleSelected) {
            const ids = visibleTaskIds(item => canPauseStatus(item.status))
            for (let i = 0; i < ids.length; ++i)
                api.pauseDownload(ids[i])
            return
        }
        const id = selectedTaskId()
        if (id.length > 0 && canPauseStatus(selectedItem.status))
            api.pauseDownload(id)
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
        pendingDeleteCompleted = false
        pendingDeleteIds = []

        if (allVisibleSelected) {
            pendingDeleteIds = visibleTaskIds()
            pendingDeleteName = pendingDeleteIds.length + " " + root.t("downloads.selectedItems")
            if (pendingDeleteIds.length > 0)
                deleteDialog.open()
            return
        }

        if (selectedIndex < 0)
            return

        updateSelection()
        pendingDeleteId = selectedTaskId()
        pendingDeleteName = selectedItem.name || root.t("common.selectedDownload")
        if (pendingDeleteId.length > 0)
            deleteDialog.open()
    }

    function requestDeleteCompleted() {
        pendingDeleteId = ""
        pendingDeleteIds = []
        pendingDeleteCompleted = true
        pendingDeleteName = root.t("downloads.completedItems")
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
        applyPresentationSettings()
    }

    Connections {
        target: nativeSettings

        function onSettingsChanged() {
            root.applyPresentationSettings()
        }
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
        sequence: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.focusSearch || "Ctrl+F")
            : ""
        enabled: !addDownloadDialog.visible
        onActivated: root.focusSearchRequested()
    }

    Shortcut {
        sequence: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.selectAllDownloads || "Ctrl+A")
            : ""
        enabled: !addDownloadDialog.visible && downloads.count > 0
        onActivated: root.selectAllVisible()
    }

    Shortcut {
        sequence: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.resumeSelected || "Ctrl+R")
            : ""
        enabled: root.api.connected && (root.selectedIndex >= 0 || root.allVisibleSelected)
        onActivated: root.resumeSelectedShortcut()
    }

    Shortcut {
        sequence: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.resumeAll || "Ctrl+Shift+R")
            : ""
        enabled: root.api.connected
        onActivated: root.api.resumeAllDownloads()
    }

    Shortcut {
        sequence: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.stopSelected || "Ctrl+S")
            : ""
        enabled: root.api.connected && (root.selectedIndex >= 0 || root.allVisibleSelected)
        onActivated: root.pauseSelectedShortcut()
    }

    Shortcut {
        sequence: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.stopAll || "Ctrl+Shift+S")
            : ""
        enabled: root.api.connected
        onActivated: root.api.pauseAllDownloads()
    }

    Shortcut {
        sequence: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.deleteSelected || "Delete")
            : ""
        enabled: (root.selectedIndex >= 0 || root.allVisibleSelected)
            && root.api.connected
            && !deleteDialog.visible
            && !redownloadDialog.visible
        onActivated: root.requestDelete()
    }

    Shortcut {
        sequence: nativeSettings.shortcutsEnabled
            ? String(nativeSettings.shortcutBindings.deleteCompleted || "Ctrl+Shift+Delete")
            : ""
        enabled: root.api.connected && !deleteDialog.visible
        onActivated: root.requestDeleteCompleted()
    }

    Shortcut {
        sequence: "Escape"
        enabled: (root.selectedIndex >= 0 || root.allVisibleSelected)
            && !addDownloadDialog.visible
            && !deleteDialog.visible
            && !redownloadDialog.visible
            && !propertiesDialog.visible
        onActivated: root.clearSelection()
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

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
            hasSelection: root.selectedIndex >= 0 || root.allVisibleSelected
            engineConnected: root.api.connected
            selectedStatus: root.selectedItem.status || ""
            canPauseSelection: root.canPauseStatus(root.selectedItem.status)
            canResumeSelection: root.canResumeStatus(root.selectedItem.status)
            hasSavePath: (root.selectedItem.savePath || "").length > 0

            onNewDownloadRequested: addDownloadDialog.openNew()
            onColumnsRequested: columnsMenu.popup()
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
                            x: 12 - list.contentX
                            width: Math.max(parent.width - 24, root.tableContentWidth() - 24)
                            height: parent.height
                            spacing: 10

                            Text {
                                Layout.preferredWidth: 28
                                text: "#"
                                color: Theme.textMuted
                                font.pixelSize: Theme.fontSmall
                                horizontalAlignment: Text.AlignHCenter
                            }

                            ToolButton {
                                Layout.fillWidth: true
                                text: root.t("common.name") + root.sortIndicator("name")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("name")
                            }
                            ToolButton {
                                Layout.preferredWidth: 88
                                visible: root.columnVisible("size")
                                text: root.t("common.size") + root.sortIndicator("size")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("size")
                            }
                            ToolButton {
                                Layout.preferredWidth: 100
                                visible: root.columnVisible("status")
                                text: root.t("common.status") + root.sortIndicator("status")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("status")
                            }
                            ToolButton {
                                Layout.preferredWidth: 90
                                visible: root.columnVisible("speed")
                                text: root.t("common.speed") + root.sortIndicator("speed")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("speed")
                            }
                            ToolButton {
                                Layout.preferredWidth: 190
                                visible: root.columnVisible("progress")
                                text: root.t("common.progress") + root.sortIndicator("progress")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("progress")
                            }


                            ToolButton {
                                Layout.preferredWidth: 70
                                visible: root.columnVisible("eta")
                                text: root.t("common.eta") + root.sortIndicator("eta")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("eta")
                            }
                            ToolButton {
                                Layout.preferredWidth: 80
                                visible: root.columnVisible("elapsed")
                                text: root.t("downloads.elapsed") + root.sortIndicator("elapsed")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("elapsed")
                            }
                            ToolButton {
                                Layout.preferredWidth: 130
                                visible: root.columnVisible("dateAdded")
                                text: root.t("downloads.dateAdded") + root.sortIndicator("dateAdded")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("dateAdded")
                            }

                            ToolButton {
                                Layout.preferredWidth: 72
                                visible: root.columnVisible("retries")
                                text: root.t("downloads.retries") + root.sortIndicator("retries")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("retries")
                            }
                            ToolButton {
                                Layout.preferredWidth: 96
                                visible: root.columnVisible("connections")
                                text: root.t("common.connections") + root.sortIndicator("connections")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("connections")
                            }
                            ToolButton {
                                Layout.preferredWidth: 90
                                visible: root.columnVisible("crc32")
                                text: root.t("downloads.crc32") + root.sortIndicator("crc32")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("crc32")
                            }
                            ToolButton {
                                Layout.preferredWidth: 90
                                visible: root.columnVisible("priority")
                                text: root.t("downloads.priority") + root.sortIndicator("priority")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("priority")
                            }
                            ToolButton {
                                Layout.preferredWidth: 130
                                visible: root.columnVisible("completedDate")
                                text: root.t("downloads.completedDate") + root.sortIndicator("completedDate")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("completedDate")
                            }
                            ToolButton {
                                Layout.preferredWidth: 200
                                visible: root.columnVisible("sourceUrl")
                                text: root.t("common.sourceUrl") + root.sortIndicator("sourceUrl")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("sourceUrl")
                            }
                            ToolButton {
                                Layout.preferredWidth: 120
                                visible: root.columnVisible("smartCategory")
                                text: root.t("downloads.smartCategory") + root.sortIndicator("smartCategory")
                                flat: true
                                Accessible.name: text
                                onClicked: root.requestSort("smartCategory")
                            }
                        }
                    }

                    ListView {
                        id: list
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        boundsBehavior: Flickable.StopAtBounds
                        flickableDirection: Flickable.HorizontalAndVerticalFlick
                        contentWidth: Math.max(width, root.tableContentWidth())
                        model: root.downloads
                        activeFocusOnTab: true
                        keyNavigationWraps: false
                        Accessible.role: Accessible.List
                        Accessible.name: root.pageTitle()
                        Accessible.description: root.pageSubtitle()
                        onActiveFocusChanged: {
                            if (activeFocus && count > 0 && currentIndex < 0)
                                currentIndex = root.selectedIndex >= 0 ? root.selectedIndex : 0
                        }
                        onCurrentIndexChanged: {
                            if (activeFocus && currentIndex >= 0 && currentIndex < count
                                && root.selectedIndex !== currentIndex) {
                                root.selectRow(currentIndex)
                            }
                        }
                        Keys.onSpacePressed: event => {
                            if (currentIndex >= 0 && currentIndex < count)
                                root.selectRow(currentIndex)
                            event.accepted = true
                        }
                        Keys.onReturnPressed: event => {
                            if (currentIndex >= 0 && currentIndex < count)
                                root.selectRow(currentIndex)
                            event.accepted = true
                        }
                        ScrollBar.vertical: ScrollBar {}
                        ScrollBar.horizontal: ScrollBar {}

                        delegate: Rectangle {
                            required property int index
                            required property string taskId
                            required property string name
                            required property string status
                            required property double sizeBytes
                            required property double progress
                            required property double speedBytesPerSec
                            required property int etaSeconds
                            required property int elapsedSeconds
                            required property string dateAdded
                            required property string url
                            required property string fileType
                            required property string category
                            required property string queueId
                            required property int connections
                            required property int retries
                            required property string completedAt
                            required property string crc32
                            required property string savePath

                            width: list.contentWidth
                            height: Theme.rowHeight
                            Accessible.role: Accessible.ListItem
                            Accessible.name: name || root.t("common.unnamedDownload")
                            Accessible.description: (status || "") + " · " + Math.round(progress * 100) + "%"
                            Accessible.focusable: true
                            Accessible.focused: list.activeFocus && list.currentIndex === index
                            Accessible.selectable: true
                            Accessible.selected: root.allVisibleSelected || root.selectedIndex === index
                            Accessible.onPressAction: root.selectRow(index)
                            color: root.allVisibleSelected || root.selectedIndex === index
                                ? Theme.surfaceSelected
                                : mouse.containsMouse ? Theme.surfaceHover : "transparent"
                            border.width: list.activeFocus && list.currentIndex === index
                                ? 2
                                : (root.allVisibleSelected || root.selectedIndex === index ? 1 : 0)
                            border.color: Theme.accent

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

                                Text {
                                    Layout.preferredWidth: 28
                                    text: String(index + 1)
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                    font.family: "monospace"
                                    horizontalAlignment: Text.AlignHCenter
                                }

                                Rectangle {
                                    Layout.preferredWidth: 38
                                    Layout.preferredHeight: 38
                                    radius: Theme.radiusSmall
                                    color: root.selectedIndex === index
                                        ? Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, 0.18)
                                        : Theme.surfaceRaised
                                    border.color: Theme.border

                                    Text {
                                        anchors.centerIn: parent
                                        text: root.fileGlyph(name, fileType, category)
                                        color: root.selectedIndex === index
                                            ? Theme.accent : Theme.textSecondary
                                        font.pixelSize: text.length > 1
                                            ? Theme.fontTiny : Theme.fontMedium
                                        font.weight: Font.DemiBold
                                    }
                                }

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
                                    visible: root.columnVisible("size")
                                    text: root.formatBytes(sizeBytes)
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                    font.family: "monospace"
                                }
                                Text {
                                    Layout.preferredWidth: 100
                                    visible: root.columnVisible("status")
                                    text: root.statusLabel(status)
                                    color: status === "completed"
                                        ? Theme.success
                                        : status === "error" || status === "failed" ? Theme.danger
                                        : status === "paused" ? Theme.warning
                                        : Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                    font.weight: Font.DemiBold
                                }
                                Text {
                                    Layout.preferredWidth: 90
                                    visible: root.columnVisible("speed")
                                    text: root.formatSpeed(speedBytesPerSec)
                                    color: speedBytesPerSec > 0 ? Theme.textPrimary : Theme.textMuted
                                    font.pixelSize: Theme.fontSmall
                                    font.family: "monospace"
                                }
                                RowLayout {
                                    Layout.preferredWidth: 190
                                    visible: root.columnVisible("progress")
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
                                    Layout.preferredWidth: 70
                                    visible: root.columnVisible("eta")
                                    text: root.formatEta(etaSeconds)
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                    font.family: "monospace"
                                }

                                Text {
                                    Layout.preferredWidth: 80
                                    visible: root.columnVisible("elapsed")
                                    text: root.formatElapsed(elapsedSeconds)
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                    font.family: "monospace"
                                }

                                Text {
                                    Layout.preferredWidth: 130
                                    visible: root.columnVisible("dateAdded")
                                    text: dateAdded.length > 0 ? dateAdded : "—"
                                    color: Theme.textMuted
                                    font.pixelSize: Theme.fontTiny
                                    font.family: "monospace"
                                    elide: Text.ElideRight
                                }


                                Text {
                                    Layout.preferredWidth: 72
                                    visible: root.columnVisible("retries")
                                    text: retries >= 0 ? String(retries) : "—"
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                    font.family: "monospace"
                                }

                                Text {
                                    Layout.preferredWidth: 96
                                    visible: root.columnVisible("connections")
                                    text: connections === 0
                                        ? root.t("downloads.autoConnections")
                                        : String(connections)
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                    font.family: "monospace"
                                }

                                Text {
                                    Layout.preferredWidth: 90
                                    visible: root.columnVisible("crc32")
                                    text: crc32.length > 0 ? crc32 : "—"
                                    color: crc32.length > 0 ? Theme.info : Theme.textMuted
                                    font.pixelSize: Theme.fontTiny
                                    font.family: "monospace"
                                    elide: Text.ElideRight
                                }

                                Text {
                                    Layout.preferredWidth: 90
                                    visible: root.columnVisible("priority")
                                    text: root.priorityLabel(queueId)
                                    color: queueId === "fast"
                                        ? Theme.danger
                                        : queueId === "night" ? Theme.warning : Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                    font.weight: Font.DemiBold
                                }

                                Text {
                                    Layout.preferredWidth: 130
                                    visible: root.columnVisible("completedDate")
                                    text: status === "completed" && completedAt.length > 0
                                        ? completedAt : "—"
                                    color: Theme.textMuted
                                    font.pixelSize: Theme.fontTiny
                                    font.family: "monospace"
                                    elide: Text.ElideRight
                                }

                                Text {
                                    Layout.preferredWidth: 200
                                    visible: root.columnVisible("sourceUrl")
                                    text: url.length > 0 ? url : "—"
                                    color: Theme.textMuted
                                    font.pixelSize: Theme.fontTiny
                                    font.family: "monospace"
                                    elide: Text.ElideMiddle
                                }

                                Text {
                                    Layout.preferredWidth: 120
                                    visible: root.columnVisible("smartCategory")
                                    text: root.smartCategoryLabel(fileType, category)
                                    color: Theme.textSecondary
                                    font.pixelSize: Theme.fontSmall
                                    elide: Text.ElideRight
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
                                    text: root.isRetryStatus(status)
                                        ? root.t("downloads.retryBeginning")
                                        : root.t("downloads.redownloadBeginning")
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
                            ? root.t("downloads.noMatch")
                            : root.page === "downloads"
                                ? root.t("downloads.noDownloads")
                                : root.t("downloads.nothingView")
                        color: Theme.textPrimary
                        font.pixelSize: Math.round(16 * Theme.fontScale)
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
                Layout.preferredWidth: root.selectedIndex >= 0
                    && nativeSettings.detailsPanelVisible ? Theme.detailsWidth : 0
                visible: root.selectedIndex >= 0 && nativeSettings.detailsPanelVisible
                item: root.selectedItem
                onCloseRequested: root.clearSelection()
                onOpenFileRequested: root.openSelectedFile()
                onOpenFolderRequested: root.revealSelectedFile()
                onPropertiesRequested: root.showSelectedProperties()
            }
        }
    }


    Menu {
        id: columnsMenu

        MenuItem {
            text: root.t("common.name")
            checkable: true
            checked: true
            enabled: false
        }
        MenuItem {
            text: root.t("common.size")
            checkable: true
            checked: root.columnVisible("size")
            onTriggered: root.toggleColumn("size")
        }
        MenuItem {
            text: root.t("common.progress")
            checkable: true
            checked: root.columnVisible("progress")
            onTriggered: root.toggleColumn("progress")
        }
        MenuItem {
            text: root.t("common.speed")
            checkable: true
            checked: root.columnVisible("speed")
            onTriggered: root.toggleColumn("speed")
        }
        MenuItem {
            text: root.t("common.eta")
            checkable: true
            checked: root.columnVisible("eta")
            onTriggered: root.toggleColumn("eta")
        }
        MenuItem {
            text: root.t("common.status")
            checkable: true
            checked: root.columnVisible("status")
            onTriggered: root.toggleColumn("status")
        }
        MenuItem {
            text: root.t("downloads.elapsed")
            checkable: true
            checked: root.columnVisible("elapsed")
            onTriggered: root.toggleColumn("elapsed")
        }
        MenuItem {
            text: root.t("downloads.dateAdded")
            checkable: true
            checked: root.columnVisible("dateAdded")
            onTriggered: root.toggleColumn("dateAdded")
        }
        MenuItem {
            text: root.t("downloads.retries")
            checkable: true
            checked: root.columnVisible("retries")
            onTriggered: root.toggleColumn("retries")
        }
        MenuItem {
            text: root.t("common.connections")
            checkable: true
            checked: root.columnVisible("connections")
            onTriggered: root.toggleColumn("connections")
        }
        MenuItem {
            text: root.t("downloads.crc32")
            checkable: true
            checked: root.columnVisible("crc32")
            onTriggered: root.toggleColumn("crc32")
        }
        MenuItem {
            text: root.t("downloads.priority")
            checkable: true
            checked: root.columnVisible("priority")
            onTriggered: root.toggleColumn("priority")
        }
        MenuItem {
            text: root.t("downloads.completedDate")
            checkable: true
            checked: root.columnVisible("completedDate")
            onTriggered: root.toggleColumn("completedDate")
        }
        MenuItem {
            text: root.t("common.sourceUrl")
            checkable: true
            checked: root.columnVisible("sourceUrl")
            onTriggered: root.toggleColumn("sourceUrl")
        }
        MenuItem {
            text: root.t("downloads.smartCategory")
            checkable: true
            checked: root.columnVisible("smartCategory")
            onTriggered: root.toggleColumn("smartCategory")
        }
        MenuSeparator {}
        MenuItem {
            text: root.t("downloads.resetColumns")
            onTriggered: root.resetColumns()
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
            if (root.pendingDeleteCompleted) {
                root.api.deleteCompletedDownloads()
            } else if (root.pendingDeleteIds.length > 0) {
                const ids = root.pendingDeleteIds.slice()
                for (let i = 0; i < ids.length; ++i)
                    root.api.deleteDownload(ids[i])
            } else if (root.pendingDeleteId.length > 0) {
                root.api.deleteDownload(root.pendingDeleteId)
            }
            root.pendingDeleteId = ""
            root.pendingDeleteIds = []
            root.pendingDeleteCompleted = false
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
