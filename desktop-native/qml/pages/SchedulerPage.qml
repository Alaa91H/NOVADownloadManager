import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var api
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function twoDigit(value) {
        return value < 10 ? "0" + value : String(value)
    }

    function triggerSummary(trigger) {
        if (!trigger) return root.t("scheduler.unknownTrigger")
        if (trigger.type === "TimeWindow")
            return root.twoDigit(trigger.start_hour) + ":"
                + root.twoDigit(trigger.start_minute) + " → "
                + root.twoDigit(trigger.end_hour) + ":"
                + root.twoDigit(trigger.end_minute)
        if (trigger.type === "BandwidthBelow")
            return root.t("scheduler.bandwidthBelow") + " " + trigger.threshold_kbps + " KB/s"
        if (trigger.type === "QueueEmpty") return root.t("scheduler.queueEmpty")
        if (trigger.type === "AllComplete") return root.t("scheduler.allComplete")
        return trigger.type || root.t("scheduler.unknownTrigger")
    }

    function actionSummary(action) {
        if (!action) return root.t("scheduler.unknownAction")
        if (action.type === "StartDownload")
            return root.t("scheduler.startTasks") + " " + ((action.task_ids || []).length) + " " + root.t("scheduler.tasks")
        if (action.type === "PauseDownload")
            return root.t("scheduler.pauseTasks") + " " + ((action.task_ids || []).length) + " " + root.t("scheduler.tasks")
        if (action.type === "SetBandwidthLimit")
            return root.t("scheduler.setBandwidth") + " " + action.kbps + " KB/s"
        if (action.type === "SetPriority")
            return root.t("scheduler.setPriority") + " " + action.priority
        if (action.type === "Notify")
            return root.t("scheduler.notify") + ": " + action.message
        if (action.type === "Shutdown") return root.t("scheduler.shutdown")
        if (action.type === "Sleep") return root.t("scheduler.sleep")
        return action.type || root.t("scheduler.unknownAction")
    }

    function parsedTaskIds() {
        return taskIdsField.text.split(/[\s,;]+/).map(v => v.trim()).filter(v => v.length > 0)
    }

    function createRule() {
        const name = ruleName.text.trim()
        if (name.length === 0) {
            formError.text = root.t("scheduler.enterName")
            return
        }

        let action
        if (actionType.currentIndex === 0) {
            const ids = parsedTaskIds()
            if (ids.length === 0) {
                formError.text = root.t("scheduler.enterTask")
                return
            }
            action = { type: "StartDownload", task_ids: ids }
        } else if (actionType.currentIndex === 1) {
            const ids = parsedTaskIds()
            if (ids.length === 0) {
                formError.text = root.t("scheduler.enterTask")
                return
            }
            action = { type: "PauseDownload", task_ids: ids }
        } else if (actionType.currentIndex === 2) {
            action = { type: "SetBandwidthLimit", kbps: bandwidthSpin.value }
        } else {
            const message = notificationField.text.trim()
            if (message.length === 0) {
                formError.text = root.t("scheduler.enterMessage")
                return
            }
            action = { type: "Notify", message: message }
        }

        const rule = {
            id: "native-" + Date.now().toString(),
            name: name,
            enabled: true,
            trigger: {
                type: "TimeWindow",
                start_hour: startHour.value,
                start_minute: startMinute.value,
                end_hour: endHour.value,
                end_minute: endMinute.value
            },
            action: action
        }

        formError.text = ""
        api.addSchedulerRule(rule)
        newRuleDialog.close()
    }

    Component.onCompleted: api.refreshScheduler()

    Timer {
        interval: 10000
        repeat: true
        running: root.visible
        onTriggered: api.refreshScheduler()
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
                    text: root.t("scheduler.title")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontTitle
                    font.weight: Font.DemiBold
                }

                Text {
                    text: root.t("scheduler.subtitle")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontSmall
                }
            }

            Item { Layout.fillWidth: true }

            Button {
                text: "+ " + root.t("scheduler.newRule")
                enabled: api.connected
                onClicked: newRuleDialog.open()
            }

            Button {
                text: root.t("action.refresh")
                onClicked: api.refreshScheduler()
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 42
            radius: Theme.radiusMedium
            color: Theme.accentMuted
            border.color: Theme.border

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 12
                anchors.rightMargin: 12

                Text {
                    Layout.fillWidth: true
                    text: api.schedulerRules.length + " " + root.t("scheduler.rulesConfigured") + " · "
                        + api.activeSchedulerRuleIds.length + " " + root.t("scheduler.currentlyActive")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                }

                Text {
                    text: api.connected ? root.t("scheduler.online") : root.t("scheduler.engineUnavailable")
                    color: api.connected ? Theme.success : Theme.warning
                    font.pixelSize: Theme.fontSmall
                    font.weight: Font.DemiBold
                }
            }
        }

        ListView {
            id: ruleList
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 8
            clip: true
            model: api.schedulerRules
            ScrollBar.vertical: ScrollBar {}

            delegate: Rectangle {
                required property var modelData
                Accessible.name: modelData.name || root.t("scheduler.unnamedRule")
                Accessible.description: root.triggerSummary(modelData.trigger) + " · " + root.actionSummary(modelData.action)
                width: ruleList.width
                height: 92
                radius: Theme.radiusMedium
                color: Theme.surface
                border.color: api.activeSchedulerRuleIds.indexOf(modelData.id) >= 0
                    ? Theme.accent
                    : Theme.border

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 12
                    spacing: 12

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 4

                        RowLayout {
                            Layout.fillWidth: true

                            Text {
                                Layout.fillWidth: true
                                text: modelData.name || root.t("scheduler.unnamedRule")
                                color: Theme.textPrimary
                                font.pixelSize: Theme.fontBody
                                font.weight: Font.DemiBold
                                elide: Text.ElideRight
                            }

                            Text {
                                text: api.activeSchedulerRuleIds.indexOf(modelData.id) >= 0 ? root.t("scheduler.activeLabel") : ""
                                color: Theme.accent
                                font.pixelSize: Theme.fontTiny
                                font.weight: Font.Bold
                            }
                        }

                        Text {
                            Layout.fillWidth: true
                            text: root.triggerSummary(modelData.trigger)
                            color: Theme.textSecondary
                            font.pixelSize: Theme.fontSmall
                            elide: Text.ElideRight
                        }

                        Text {
                            Layout.fillWidth: true
                            text: root.actionSummary(modelData.action)
                            color: Theme.textMuted
                            font.pixelSize: Theme.fontSmall
                            elide: Text.ElideRight
                        }
                    }

                    Switch {
                        checked: Boolean(modelData.enabled)
                        enabled: api.connected
                        text: checked ? root.t("scheduler.enabled") : root.t("scheduler.disabled")
                        onClicked: api.setSchedulerRuleEnabled(modelData.id, checked)
                    }

                    Button {
                        text: root.t("action.delete")
                        flat: true
                        enabled: api.connected
                        onClicked: api.deleteSchedulerRule(modelData.id)
                    }
                }
            }
        }

        ColumnLayout {
            Layout.alignment: Qt.AlignCenter
            visible: api.schedulerRules.length === 0
            spacing: 6

            Text {
                Layout.alignment: Qt.AlignHCenter
                text: root.t("scheduler.noRules")
                color: Theme.textPrimary
                font.pixelSize: Math.round(16 * Theme.fontScale)
                font.weight: Font.DemiBold
            }

            Text {
                text: root.t("scheduler.noRulesSubtitle")
                color: Theme.textMuted
                font.pixelSize: Theme.fontSmall
            }
        }
    }

    Dialog {
        id: newRuleDialog

        modal: true
        focus: true
        closePolicy: Popup.CloseOnEscape
        width: Math.min(620, parent ? parent.width - 48 : 620)
        title: root.t("scheduler.dialogTitle")

        background: Rectangle {
            color: Theme.surfaceRaised
            border.color: Theme.borderStrong
            border.width: 1
            radius: Theme.radiusLarge
        }

        contentItem: ColumnLayout {
            spacing: 12

            TextField {
                id: ruleName
                Layout.fillWidth: true
                placeholderText: root.t("scheduler.ruleName")
                Accessible.name: root.t("scheduler.ruleName")
                KeyNavigation.tab: startHour
            }

            Text {
                text: root.t("scheduler.timeWindow")
                color: Theme.textSecondary
                font.pixelSize: Math.round(11 * Theme.fontScale)
                font.weight: Font.DemiBold
            }

            RowLayout {
                Layout.fillWidth: true

                Text { text: root.t("scheduler.start"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                SpinBox { id: startHour; from: 0; to: 23; value: 1; Accessible.name: root.t("scheduler.start") + " hour"; KeyNavigation.tab: startMinute }
                Text { text: ":"; color: Theme.textMuted }
                SpinBox { id: startMinute; from: 0; to: 59; value: 0; Accessible.name: root.t("scheduler.start") + " minute"; KeyNavigation.tab: endHour }

                Item { Layout.fillWidth: true }

                Text { text: root.t("scheduler.end"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                SpinBox { id: endHour; from: 0; to: 23; value: 7; Accessible.name: root.t("scheduler.end") + " hour"; KeyNavigation.tab: endMinute }
                Text { text: ":"; color: Theme.textMuted }
                SpinBox { id: endMinute; from: 0; to: 59; value: 0; Accessible.name: root.t("scheduler.end") + " minute"; KeyNavigation.tab: actionType }
            }

            ComboBox {
                id: actionType
                Layout.fillWidth: true
                Accessible.name: root.t("scheduler.unknownAction")
                model: [root.t("scheduler.startDownloads"), root.t("scheduler.pauseDownloads"), root.t("scheduler.setBandwidthLimit"), root.t("scheduler.notification")]
            }

            TextField {
                id: taskIdsField
                Layout.fillWidth: true
                visible: actionType.currentIndex === 0 || actionType.currentIndex === 1
                placeholderText: root.t("scheduler.taskIds")
                LayoutMirroring.enabled: false
                horizontalAlignment: Text.AlignLeft
                Accessible.name: root.t("scheduler.taskIds")
            }

            RowLayout {
                Layout.fillWidth: true
                visible: actionType.currentIndex === 2

                Text {
                    text: root.t("scheduler.bandwidthLimit")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                }

                SpinBox {
                    id: bandwidthSpin
                    from: 0
                    to: 1000000
                    value: 5000
                    editable: true
                }

                Text {
                    text: root.t("scheduler.unlimited")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontSmall
                }
            }

            TextField {
                id: notificationField
                Layout.fillWidth: true
                visible: actionType.currentIndex === 3
                placeholderText: root.t("scheduler.notificationMessage")
            }

            Text {
                id: formError
                Layout.fillWidth: true
                visible: text.length > 0
                color: Theme.danger
                font.pixelSize: Theme.fontSmall
                wrapMode: Text.WordWrap
            }

            RowLayout {
                Layout.fillWidth: true

                Button {
                    text: root.t("common.cancel")
                    onClicked: newRuleDialog.close()
                }

                Item { Layout.fillWidth: true }

                Button {
                    text: root.t("scheduler.createRule")
                    enabled: api.connected
                    onClicked: root.createRule()
                }
            }
        }
    }
}
