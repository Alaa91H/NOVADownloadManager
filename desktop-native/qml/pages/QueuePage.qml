import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var api
    required property var downloads

    property string selectedQueueId: "main"
    property var selectedQueue: ({})
    property string errorText: ""
    property string statusText: ""
    property string pendingDeleteQueueId: ""
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function formatBytes(value) {
        const bytes = Number(value || 0)
        if (bytes <= 0) return "—"
        if (bytes >= 1024 * 1024 * 1024)
            return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB"
        if (bytes >= 1024 * 1024)
            return (bytes / (1024 * 1024)).toFixed(1) + " MB"
        if (bytes >= 1024)
            return (bytes / 1024).toFixed(0) + " KB"
        return bytes + " B"
    }

    function formatKbps(value) {
        const kbps = Number(value || 0)
        if (kbps <= 0) return root.t("queue.unlimited")
        if (kbps >= 1024)
            return (kbps / 1024).toFixed(1) + " MB/s"
        return kbps + " KB/s"
    }

    function taskInfo(taskId) {
        const item = downloads.itemById(taskId)
        return item && item.taskId ? item : ({})
    }

    function queueById(queueId) {
        for (let i = 0; i < api.queueCatalog.length; ++i) {
            const queue = api.queueCatalog[i]
            if (String(queue.id || "") === String(queueId || ""))
                return queue
        }
        return ({})
    }

    function queueIndex(queueId) {
        for (let i = 0; i < api.queueCatalog.length; ++i) {
            if (String(api.queueCatalog[i].id || "") === String(queueId || ""))
                return i
        }
        return -1
    }

    function queueLabelIndex(queueId) {
        for (let i = 0; i < api.knownQueueIds.length; ++i) {
            if (String(api.knownQueueIds[i]) === String(queueId || ""))
                return i
        }
        return 0
    }

    function selectQueueIndex(index) {
        if (index < 0 || index >= api.queueCatalog.length)
            return
        const queue = api.queueCatalog[index]
        selectedQueueId = String(queue.id || "")
        refreshSelectedQueue()
        pendingDeleteQueueId = ""
    }

    function refreshSelectedQueue() {
        let queue = queueById(selectedQueueId)
        if (!queue.id) {
            queue = queueById("main")
            if (!queue.id && api.queueCatalog.length > 0)
                queue = api.queueCatalog[0]
            selectedQueueId = String(queue.id || "")
        }
        selectedQueue = queue
    }

    function engineQueueEntry(taskId) {
        for (let i = 0; i < api.queueEntries.length; ++i) {
            const entry = api.queueEntries[i]
            if (String(entry.task_id || "") === String(taskId || ""))
                return entry
        }
        return ({})
    }

    function priorityIndex(priority) {
        if (priority === "Critical") return 0
        if (priority === "High") return 1
        if (priority === "Low") return 3
        if (priority === "Background") return 4
        return 2
    }

    function taskMatchesSearch(info) {
        const query = taskSearch.text.trim().toLowerCase()
        if (query.length === 0)
            return true
        return String(info.name || "").toLowerCase().indexOf(query) >= 0
            || String(info.url || "").toLowerCase().indexOf(query) >= 0
            || String(info.taskId || "").toLowerCase().indexOf(query) >= 0
    }

    Component.onCompleted: {
        api.refreshDownloads()
        api.refreshQueueCatalog()
        api.refreshQueue()
        api.refreshEngineProfiles()
    }

    Timer {
        interval: 5000
        repeat: true
        running: root.visible
        onTriggered: {
            api.refreshQueueCatalog()
            api.refreshQueue()
        }
    }

    Connections {
        target: api

        function onQueueCatalogChanged() {
            root.refreshSelectedQueue()
        }

        function onQueueCatalogActionCompleted(action, queueId) {
            root.errorText = ""
            if (action === "create") {
                root.selectedQueueId = queueId
                root.refreshSelectedQueue()
                root.statusText = root.t("queue.created")
            } else if (action === "delete") {
                if (root.selectedQueueId === queueId)
                    root.selectedQueueId = "main"
                root.pendingDeleteQueueId = ""
                root.refreshSelectedQueue()
                root.statusText = root.t("queue.deleted")
            } else if (action === "move-task") {
                root.statusText = root.t("queue.taskMoved")
            } else if (action === "reorder-task" || action === "reorder") {
                root.statusText = root.t("queue.reordered")
            } else if (action === "update") {
                root.statusText = root.t("queue.saved")
            } else if (action === "start") {
                root.statusText = root.t("queue.started")
            } else if (action === "stop") {
                root.statusText = root.t("queue.stopped")
            }
        }

        function onRequestFailed(message) {
            if (root.visible) {
                root.errorText = message
                root.statusText = ""
            }
        }
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
                    text: root.t("queue.title")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontTitle
                    font.weight: Font.DemiBold
                }
                Text {
                    text: root.t("queue.managerSubtitle")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontSmall
                }
            }

            Item { Layout.fillWidth: true }

            Rectangle {
                implicitWidth: 110
                implicitHeight: 54
                radius: Theme.radiusMedium
                color: Theme.surface
                border.color: Theme.border
                Column {
                    anchors.centerIn: parent
                    spacing: 2
                    Text {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: api.queueCatalog.length
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontMedium
                        font.weight: Font.DemiBold
                    }
                    Text {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: root.t("queue.queues")
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                    }
                }
            }

            Rectangle {
                implicitWidth: 130
                implicitHeight: 54
                radius: Theme.radiusMedium
                color: Theme.surface
                border.color: Theme.border
                Column {
                    anchors.centerIn: parent
                    spacing: 2
                    Text {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: root.formatKbps(api.queueTotalBandwidthKbps)
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.DemiBold
                    }
                    Text {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: root.t("queue.bandwidth")
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                    }
                }
            }

            Button {
                text: root.t("action.refresh")
                onClicked: {
                    api.refreshDownloads()
                    api.refreshQueueCatalog()
                    api.refreshQueue()
                }
            }
        }

        SplitView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            orientation: Qt.Horizontal

            Rectangle {
                SplitView.preferredWidth: 260
                SplitView.minimumWidth: 220
                color: Theme.surface
                radius: Theme.radiusMedium
                border.color: Theme.border

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 10
                    spacing: 8

                    Text {
                        text: root.t("queue.queues")
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontBody
                        font.weight: Font.DemiBold
                    }

                    ListView {
                        id: queueCatalogList
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        model: api.queueCatalog
                        spacing: 4
                        clip: true
                        activeFocusOnTab: true
                        keyNavigationWraps: false
                        Accessible.name: root.t("queue.queues")
                        onActiveFocusChanged: {
                            if (activeFocus && count > 0) {
                                const selected = root.queueIndex(root.selectedQueueId)
                                currentIndex = selected >= 0 ? selected : 0
                            }
                        }
                        onCurrentIndexChanged: {
                            if (activeFocus)
                                root.selectQueueIndex(currentIndex)
                        }
                        Keys.onSpacePressed: event => {
                            root.selectQueueIndex(currentIndex)
                            event.accepted = true
                        }
                        Keys.onReturnPressed: event => {
                            root.selectQueueIndex(currentIndex)
                            event.accepted = true
                        }
                        ScrollBar.vertical: ScrollBar {}

                        delegate: Rectangle {
                            required property int index
                            required property var modelData
                            width: queueCatalogList.width
                            height: 58
                            radius: Theme.radiusSmall
                            color: root.selectedQueueId === String(modelData.id)
                                ? Theme.accentMuted
                                : Theme.surfaceRaised
                            border.width: queueCatalogList.activeFocus
                                && queueCatalogList.currentIndex === index ? 2 : 1
                            border.color: queueCatalogList.activeFocus
                                && queueCatalogList.currentIndex === index
                                ? Theme.focusRing
                                : root.selectedQueueId === String(modelData.id)
                                    ? Theme.accent
                                    : Theme.border
                            Accessible.name: modelData.name || modelData.id
                            Accessible.description: (modelData.downloadOrder
                                ? modelData.downloadOrder.length : 0)
                                + " " + root.t("queue.tasks")

                            MouseArea {
                                anchors.fill: parent
                                onClicked: {
                                    queueCatalogList.currentIndex = index
                                    root.selectQueueIndex(index)
                                }
                            }

                            RowLayout {
                                anchors.fill: parent
                                anchors.margins: 7
                                spacing: 4

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 1
                                    Text {
                                        Layout.fillWidth: true
                                        text: modelData.name || modelData.id
                                        color: Theme.textPrimary
                                        font.pixelSize: Theme.fontSmall
                                        font.weight: Font.DemiBold
                                        elide: Text.ElideRight
                                    }
                                    Text {
                                        text: (modelData.downloadOrder ? modelData.downloadOrder.length : 0)
                                            + " " + root.t("queue.tasks")
                                        color: Theme.textMuted
                                        font.pixelSize: Theme.fontTiny
                                    }
                                }

                                ToolButton {
                                    text: "↑"
                                    enabled: root.queueIndex(String(modelData.id)) > 0
                                    onClicked: api.moveQueue(String(modelData.id), -1)
                                    Accessible.name: root.t("queue.moveUp")
                                }
                                ToolButton {
                                    text: "↓"
                                    enabled: {
                                        const index = root.queueIndex(String(modelData.id))
                                        return index >= 0 && index < api.queueCatalog.length - 1
                                    }
                                    onClicked: api.moveQueue(String(modelData.id), 1)
                                    Accessible.name: root.t("queue.moveDown")
                                }
                            }
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        TextField {
                            id: newQueueName
                            Layout.fillWidth: true
                            placeholderText: root.t("queue.newName")
                            Accessible.name: root.t("queue.newName")
                            onAccepted: {
                                if (text.trim().length > 0) {
                                    api.createQueue(text.trim())
                                    text = ""
                                }
                            }
                        }
                        Button {
                            text: "+"
                            enabled: newQueueName.text.trim().length > 0
                            onClicked: {
                                api.createQueue(newQueueName.text.trim())
                                newQueueName.text = ""
                            }
                            Accessible.name: root.t("queue.create")
                        }
                    }
                }
            }

            Rectangle {
                SplitView.fillWidth: true
                SplitView.minimumWidth: 560
                color: Theme.surface
                radius: Theme.radiusMedium
                border.color: Theme.border

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 10
                    spacing: 8

                    RowLayout {
                        Layout.fillWidth: true

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 1
                            Text {
                                Layout.fillWidth: true
                                text: root.selectedQueue.name || root.selectedQueueId
                                color: Theme.textPrimary
                                font.pixelSize: Theme.fontMedium
                                font.weight: Font.DemiBold
                                elide: Text.ElideRight
                            }
                            Text {
                                text: (root.selectedQueue.downloadOrder
                                    ? root.selectedQueue.downloadOrder.length
                                    : 0) + " " + root.t("queue.tasks")
                                color: Theme.textMuted
                                font.pixelSize: Theme.fontTiny
                            }
                        }

                        Button {
                            text: root.t("queue.stop")
                            enabled: api.connected && Boolean(root.selectedQueue.id)
                            onClicked: api.stopQueue(root.selectedQueueId)
                        }
                        Button {
                            text: root.t("queue.start")
                            enabled: api.connected && Boolean(root.selectedQueue.id)
                            onClicked: api.startQueue(root.selectedQueueId)
                        }

                        Button {
                            visible: root.selectedQueueId !== "main"
                                && root.pendingDeleteQueueId !== root.selectedQueueId
                            text: root.t("queue.delete")
                            onClicked: root.pendingDeleteQueueId = root.selectedQueueId
                        }
                        Button {
                            visible: root.selectedQueueId !== "main"
                                && root.pendingDeleteQueueId === root.selectedQueueId
                            text: root.t("queue.confirmDelete")
                            onClicked: api.deleteQueue(root.selectedQueueId)
                        }
                        Button {
                            visible: root.pendingDeleteQueueId === root.selectedQueueId
                                && root.selectedQueueId !== "main"
                            text: root.t("common.cancel")
                            onClicked: root.pendingDeleteQueueId = ""
                        }
                    }

                    TabBar {
                        id: queueTabs
                        Layout.fillWidth: true
                        TabButton { text: root.t("queue.tasks") }
                        TabButton { text: root.t("queue.settings") }
                    }

                    StackLayout {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        currentIndex: queueTabs.currentIndex

                        ColumnLayout {
                            spacing: 8

                            RowLayout {
                                Layout.fillWidth: true
                                TextField {
                                    id: taskSearch
                                    Layout.fillWidth: true
                                    placeholderText: root.t("queue.searchTasks")
                                    Accessible.name: root.t("queue.searchTasks")
                                }
                                Text {
                                    text: root.t("queue.next") + ": "
                                        + (api.nextQueuedTask.length > 0 ? api.nextQueuedTask : "—")
                                    color: Theme.textMuted
                                    font.pixelSize: Theme.fontTiny
                                }
                            }

                            Rectangle {
                                Layout.fillWidth: true
                                Layout.fillHeight: true
                                color: Theme.surfaceRaised
                                radius: Theme.radiusSmall
                                border.color: Theme.border
                                clip: true

                                ListView {
                                    id: taskList
                                    anchors.fill: parent
                                    anchors.margins: 1
                                    model: root.selectedQueue.downloadOrder || []
                                    clip: true
                                    spacing: 1
                                    activeFocusOnTab: true
                                    keyNavigationWraps: false
                                    Accessible.name: root.t("queue.tasks")
                                    onActiveFocusChanged: {
                                        if (activeFocus && count > 0 && currentIndex < 0)
                                            currentIndex = 0
                                    }
                                    ScrollBar.vertical: ScrollBar {}

                                    delegate: Rectangle {
                                        id: taskRow
                                        required property var modelData
                                        readonly property var info: root.taskInfo(String(modelData))
                                        readonly property var engineEntry: root.engineQueueEntry(String(modelData))
                                        readonly property bool matches: root.taskMatchesSearch(info)

                                        width: taskList.width
                                        height: matches ? 60 : 0
                                        visible: matches
                                        color: rowMouse.containsMouse ? Theme.surfaceHover : "transparent"
                                        border.width: taskList.activeFocus
                                            && taskList.currentIndex === index ? 2 : 0
                                        border.color: Theme.focusRing
                                        Accessible.name: taskRow.info.name || String(modelData)
                                        Accessible.description: (taskRow.info.status || root.t("common.unknown"))
                                            + " · " + root.formatBytes(taskRow.info.sizeBytes)

                                        RowLayout {
                                            anchors.fill: parent
                                            anchors.leftMargin: 9
                                            anchors.rightMargin: 9
                                            spacing: 7

                                            ColumnLayout {
                                                Layout.fillWidth: true
                                                spacing: 1
                                                Text {
                                                    Layout.fillWidth: true
                                                    text: taskRow.info.name || String(modelData)
                                                    color: Theme.textPrimary
                                                    font.pixelSize: Theme.fontSmall
                                                    font.weight: Font.Medium
                                                    elide: Text.ElideMiddle
                                                }
                                                Text {
                                                    Layout.fillWidth: true
                                                    text: (taskRow.info.status || root.t("common.unknown"))
                                                        + " · " + root.formatBytes(taskRow.info.sizeBytes)
                                                    color: Theme.textMuted
                                                    font.pixelSize: Theme.fontTiny
                                                    elide: Text.ElideRight
                                                }
                                            }

                                            ToolButton {
                                                text: "↑"
                                                enabled: index > 0
                                                onClicked: api.moveQueueTask(
                                                    root.selectedQueueId,
                                                    String(modelData),
                                                    -1
                                                )
                                                Accessible.name: root.t("queue.moveUp")
                                            }
                                            ToolButton {
                                                text: "↓"
                                                enabled: index < taskList.count - 1
                                                onClicked: api.moveQueueTask(
                                                    root.selectedQueueId,
                                                    String(modelData),
                                                    1
                                                )
                                                Accessible.name: root.t("queue.moveDown")
                                            }

                                            ComboBox {
                                                Layout.preferredWidth: 125
                                                model: ["Critical", "High", "Normal", "Low", "Background"]
                                                currentIndex: root.priorityIndex(taskRow.engineEntry.priority)
                                                enabled: api.connected
                                                onActivated: index => api.setQueuePriority(
                                                    String(modelData),
                                                    index
                                                )
                                                Accessible.name: root.t("queue.priority")
                                            }

                                            ComboBox {
                                                Layout.preferredWidth: 150
                                                model: api.knownQueueLabels
                                                currentIndex: root.queueLabelIndex(root.selectedQueueId)
                                                enabled: api.knownQueueIds.length > 1
                                                onActivated: index => {
                                                    if (index >= 0 && index < api.knownQueueIds.length) {
                                                        const target = String(api.knownQueueIds[index])
                                                        if (target !== root.selectedQueueId)
                                                            api.moveTaskToQueue(String(modelData), target)
                                                    }
                                                }
                                                Accessible.name: root.t("queue.moveTo")
                                            }
                                        }

                                        MouseArea {
                                            id: rowMouse
                                            anchors.fill: parent
                                            acceptedButtons: Qt.NoButton
                                            hoverEnabled: true
                                        }
                                    }
                                }

                                ColumnLayout {
                                    anchors.centerIn: parent
                                    visible: !root.selectedQueue.downloadOrder
                                        || root.selectedQueue.downloadOrder.length === 0
                                    spacing: 4
                                    Text {
                                        Layout.alignment: Qt.AlignHCenter
                                        text: root.t("queue.empty")
                                        color: Theme.textPrimary
                                        font.pixelSize: Theme.fontBody
                                        font.weight: Font.DemiBold
                                    }
                                    Text {
                                        text: root.t("queue.emptyManagedSubtitle")
                                        color: Theme.textMuted
                                        font.pixelSize: Theme.fontSmall
                                    }
                                }
                            }
                        }

                        ScrollView {
                            clip: true
                            QueueSettingsPanel {
                                width: parent.availableWidth
                                api: root.api
                                queue: root.selectedQueue
                            }
                        }
                    }
                }
            }
        }

        Text {
            Layout.fillWidth: true
            visible: root.errorText.length > 0
            text: root.errorText
            color: Theme.danger
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.WordWrap
        }

        Text {
            Layout.fillWidth: true
            visible: root.statusText.length > 0 && root.errorText.length === 0
            text: root.statusText
            color: Theme.success
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.WordWrap
        }
    }
}
