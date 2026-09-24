import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var api

    function twoDigit(value) {
        return value < 10 ? "0" + value : String(value)
    }

    function triggerSummary(trigger) {
        if (!trigger) return "Unknown trigger"
        if (trigger.type === "TimeWindow")
            return root.twoDigit(trigger.start_hour) + ":"
                + root.twoDigit(trigger.start_minute) + " → "
                + root.twoDigit(trigger.end_hour) + ":"
                + root.twoDigit(trigger.end_minute)
        if (trigger.type === "BandwidthBelow")
            return "Bandwidth below " + trigger.threshold_kbps + " KB/s"
        if (trigger.type === "QueueEmpty") return "Queue becomes empty"
        if (trigger.type === "AllComplete") return "All downloads complete"
        return trigger.type || "Unknown trigger"
    }

    function actionSummary(action) {
        if (!action) return "Unknown action"
        if (action.type === "StartDownload")
            return "Start " + ((action.task_ids || []).length) + " task(s)"
        if (action.type === "PauseDownload")
            return "Pause " + ((action.task_ids || []).length) + " task(s)"
        if (action.type === "SetBandwidthLimit")
            return "Set bandwidth to " + action.kbps + " KB/s"
        if (action.type === "SetPriority")
            return "Set priority to " + action.priority
        if (action.type === "Notify")
            return "Notify: " + action.message
        if (action.type === "Shutdown") return "Shutdown computer"
        if (action.type === "Sleep") return "Sleep computer"
        return action.type || "Unknown action"
    }

    function parsedTaskIds() {
        return taskIdsField.text.split(/[\s,;]+/).map(v => v.trim()).filter(v => v.length > 0)
    }

    function createRule() {
        const name = ruleName.text.trim()
        if (name.length === 0) {
            formError.text = "Enter a rule name."
            return
        }

        let action
        if (actionType.currentIndex === 0) {
            const ids = parsedTaskIds()
            if (ids.length === 0) {
                formError.text = "Enter at least one task ID."
                return
            }
            action = { type: "StartDownload", task_ids: ids }
        } else if (actionType.currentIndex === 1) {
            const ids = parsedTaskIds()
            if (ids.length === 0) {
                formError.text = "Enter at least one task ID."
                return
            }
            action = { type: "PauseDownload", task_ids: ids }
        } else if (actionType.currentIndex === 2) {
            action = { type: "SetBandwidthLimit", kbps: bandwidthSpin.value }
        } else {
            const message = notificationField.text.trim()
            if (message.length === 0) {
                formError.text = "Enter a notification message."
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
                    text: "Scheduler"
                    color: Theme.textPrimary
                    font.pixelSize: 21
                    font.weight: Font.DemiBold
                }

                Text {
                    text: "Rules execute inside the NOVA Rust daemon, not in the UI"
                    color: Theme.textMuted
                    font.pixelSize: 10
                }
            }

            Item { Layout.fillWidth: true }

            Button {
                text: "+ New rule"
                enabled: api.connected
                onClicked: newRuleDialog.open()
            }

            Button {
                text: "Refresh"
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
                    text: api.schedulerRules.length + " rule(s) configured · "
                        + api.activeSchedulerRuleIds.length + " currently active"
                    color: Theme.textSecondary
                    font.pixelSize: 10
                }

                Text {
                    text: api.connected ? "Daemon scheduler online" : "Engine unavailable"
                    color: api.connected ? Theme.success : Theme.warning
                    font.pixelSize: 10
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
                                text: modelData.name || "Unnamed rule"
                                color: Theme.textPrimary
                                font.pixelSize: 13
                                font.weight: Font.DemiBold
                                elide: Text.ElideRight
                            }

                            Text {
                                text: api.activeSchedulerRuleIds.indexOf(modelData.id) >= 0 ? "ACTIVE" : ""
                                color: Theme.accent
                                font.pixelSize: 9
                                font.weight: Font.Bold
                            }
                        }

                        Text {
                            Layout.fillWidth: true
                            text: root.triggerSummary(modelData.trigger)
                            color: Theme.textSecondary
                            font.pixelSize: 10
                            elide: Text.ElideRight
                        }

                        Text {
                            Layout.fillWidth: true
                            text: root.actionSummary(modelData.action)
                            color: Theme.textMuted
                            font.pixelSize: 10
                            elide: Text.ElideRight
                        }
                    }

                    Switch {
                        checked: Boolean(modelData.enabled)
                        enabled: api.connected
                        text: checked ? "Enabled" : "Disabled"
                        onClicked: api.setSchedulerRuleEnabled(modelData.id, checked)
                    }

                    Button {
                        text: "Delete"
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
                text: "No scheduler rules"
                color: Theme.textPrimary
                font.pixelSize: 16
                font.weight: Font.DemiBold
            }

            Text {
                text: "Create a time-window rule to automate download actions."
                color: Theme.textMuted
                font.pixelSize: 10
            }
        }
    }

    Dialog {
        id: newRuleDialog

        modal: true
        focus: true
        closePolicy: Popup.CloseOnEscape
        width: Math.min(620, parent ? parent.width - 48 : 620)
        title: "New scheduler rule"

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
                placeholderText: "Rule name"
            }

            Text {
                text: "Time window"
                color: Theme.textSecondary
                font.pixelSize: 11
                font.weight: Font.DemiBold
            }

            RowLayout {
                Layout.fillWidth: true

                Text { text: "Start"; color: Theme.textMuted; font.pixelSize: 10 }
                SpinBox { id: startHour; from: 0; to: 23; value: 1 }
                Text { text: ":"; color: Theme.textMuted }
                SpinBox { id: startMinute; from: 0; to: 59; value: 0 }

                Item { Layout.fillWidth: true }

                Text { text: "End"; color: Theme.textMuted; font.pixelSize: 10 }
                SpinBox { id: endHour; from: 0; to: 23; value: 7 }
                Text { text: ":"; color: Theme.textMuted }
                SpinBox { id: endMinute; from: 0; to: 59; value: 0 }
            }

            ComboBox {
                id: actionType
                Layout.fillWidth: true
                model: ["Start downloads", "Pause downloads", "Set bandwidth limit", "Notification"]
            }

            TextField {
                id: taskIdsField
                Layout.fillWidth: true
                visible: actionType.currentIndex === 0 || actionType.currentIndex === 1
                placeholderText: "Task IDs separated by commas"
            }

            RowLayout {
                Layout.fillWidth: true
                visible: actionType.currentIndex === 2

                Text {
                    text: "Bandwidth limit"
                    color: Theme.textSecondary
                    font.pixelSize: 10
                }

                SpinBox {
                    id: bandwidthSpin
                    from: 0
                    to: 1000000
                    value: 5000
                    editable: true
                }

                Text {
                    text: "KB/s (0 = unlimited)"
                    color: Theme.textMuted
                    font.pixelSize: 10
                }
            }

            TextField {
                id: notificationField
                Layout.fillWidth: true
                visible: actionType.currentIndex === 3
                placeholderText: "Notification message"
            }

            Text {
                id: formError
                Layout.fillWidth: true
                visible: text.length > 0
                color: Theme.danger
                font.pixelSize: 10
                wrapMode: Text.WordWrap
            }

            RowLayout {
                Layout.fillWidth: true

                Button {
                    text: "Cancel"
                    onClicked: newRuleDialog.close()
                }

                Item { Layout.fillWidth: true }

                Button {
                    text: "Create rule"
                    enabled: api.connected
                    onClicked: root.createRule()
                }
            }
        }
    }
}
