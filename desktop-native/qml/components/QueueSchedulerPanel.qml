import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var api
    property string selectedQueueId: "main"
    property var selectedQueue: ({})
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function queueById(queueId) {
        for (let i = 0; i < api.queueCatalog.length; ++i) {
            const queue = api.queueCatalog[i]
            if (String(queue.id || "") === String(queueId || ""))
                return queue
        }
        return ({})
    }

    function refreshSelectedQueue() {
        let queue = queueById(selectedQueueId)
        if (!queue.id && api.queueCatalog.length > 0) {
            queue = api.queueCatalog[0]
            selectedQueueId = String(queue.id || "")
        }
        selectedQueue = queue
    }

    function queueIndex(queueId) {
        for (let i = 0; i < api.queueCatalog.length; ++i) {
            if (String(api.queueCatalog[i].id || "") === String(queueId || ""))
                return i
        }
        return -1
    }

    function scheduleSummary(queue) {
        if (!queue || !queue.id)
            return root.t("scheduler.queueUnavailable")
        if (!queue.scheduled)
            return root.t("scheduler.queueScheduleDisabled")

        const type = String(queue.scheduleType || "daily")
        const typeLabel = type === "once"
            ? root.t("queue.once")
            : type === "custom"
                ? root.t("queue.custom")
                : root.t("queue.daily")
        const window = String(queue.startTime || "00:00")
            + " → " + String(queue.endTime || "23:59")
        return typeLabel + " · " + window
    }

    Component.onCompleted: {
        api.refreshQueueCatalog()
        api.refreshEngineProfiles()
        api.refreshScheduler()
        refreshSelectedQueue()
    }

    Connections {
        target: api

        function onQueueCatalogChanged() {
            root.refreshSelectedQueue()
        }
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 10

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: headerRow.implicitHeight + 18
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            RowLayout {
                id: headerRow
                anchors.fill: parent
                anchors.margins: 9
                spacing: 10

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2

                    Text {
                        text: root.t("scheduler.queueSchedulesTitle")
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontBody
                        font.weight: Font.DemiBold
                    }

                    Text {
                        Layout.fillWidth: true
                        text: root.scheduleSummary(root.selectedQueue)
                        color: root.selectedQueue.active ? Theme.success : Theme.textMuted
                        font.pixelSize: Theme.fontSmall
                        elide: Text.ElideRight
                    }
                }

                ComboBox {
                    id: queueSelector
                    Layout.preferredWidth: 220
                    model: api.queueCatalog
                    textRole: "name"
                    valueRole: "id"
                    currentIndex: root.queueIndex(root.selectedQueueId)
                    onActivated: index => {
                        if (index >= 0 && index < api.queueCatalog.length) {
                            root.selectedQueueId = String(api.queueCatalog[index].id || "")
                            root.refreshSelectedQueue()
                        }
                    }
                    Accessible.name: root.t("scheduler.selectQueue")
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
            }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: powerRow.implicitHeight + 16
            radius: Theme.radiusMedium
            color: Theme.surfaceRaised
            border.color: Theme.border

            RowLayout {
                id: powerRow
                anchors.fill: parent
                anchors.margins: 8
                spacing: 10

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Text {
                        text: root.t("scheduler.powerCommands")
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.DemiBold
                    }
                    Text {
                        Layout.fillWidth: true
                        text: root.t("scheduler.powerCommandsHint")
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                        wrapMode: Text.WordWrap
                    }
                }

                Switch {
                    checked: api.schedulerPowerCommandsEnabled
                    text: checked
                        ? root.t("scheduler.enabled")
                        : root.t("scheduler.disabled")
                    onClicked: api.setSchedulerPowerCommandsEnabled(checked)
                }
            }
        }

        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true

            QueueSettingsPanel {
                width: parent.availableWidth
                api: root.api
                queue: root.selectedQueue
            }
        }

        Text {
            Layout.fillWidth: true
            text: root.t("scheduler.queueOrderingHint")
            color: Theme.textMuted
            font.pixelSize: Theme.fontTiny
            wrapMode: Text.WordWrap
        }
    }
}
