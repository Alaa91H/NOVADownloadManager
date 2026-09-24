import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    required property var api
    property var queue: ({})
    property string languageToken: i18n.language

    radius: Theme.radiusMedium
    color: Theme.surfaceRaised
    border.color: Theme.border
    implicitHeight: form.implicitHeight + 20

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function boolValue(key, fallback) {
        const value = queue[key]
        return value === undefined || value === null ? fallback : Boolean(value)
    }

    function numberValue(key, fallback) {
        const value = Number(queue[key])
        return Number.isFinite(value) ? value : fallback
    }

    function profileIndex(profileId) {
        const wanted = String(profileId || "")
        for (let i = 0; i < api.engineProfiles.length; ++i) {
            if (String(api.engineProfiles[i].id || "") === wanted)
                return i
        }
        if (wanted.length === 0) {
            for (let j = 0; j < api.engineProfiles.length; ++j) {
                if (String(api.engineProfiles[j].id || "") === String(api.activeEngineProfile || ""))
                    return j
            }
        }
        return api.engineProfiles.length > 0 ? 0 : -1
    }

    function load() {
        nameField.text = String(queue.name || "")
        scheduledCheck.checked = boolValue("scheduled", false)

        const type = String(queue.scheduleType || "daily")
        scheduleType.currentIndex = type === "once" ? 0 : type === "custom" ? 2 : 1

        startTime.text = String(queue.startTime || "02:00")
        endTime.text = String(queue.endTime || "08:00")
        maxActive.value = Math.max(1, numberValue("maxActive", 1))
        limitSpeed.checked = boolValue("limitSpeed", false)
        speedLimit.value = Math.max(0, numberValue("speedLimitKbs", 1024))
        oneTimeLimit.checked = boolValue("oneTimeLimit", false)
        shutdownCheck.checked = boolValue("shutdownOnComplete", false)
        sleepCheck.checked = boolValue("hangupOnComplete", false)
        exitCheck.checked = boolValue("exitOnComplete", false)
        retryCount.value = Math.max(0, numberValue("retryCount", 3))
        retryDelay.value = Math.max(1, numberValue("retryDelay", 10))
        profileBox.currentIndex = profileIndex(queue.profileId)

        const days = Array.isArray(queue.days) ? queue.days : [0,1,2,3,4,5,6]
        day0.checked = days.indexOf(0) >= 0
        day1.checked = days.indexOf(1) >= 0
        day2.checked = days.indexOf(2) >= 0
        day3.checked = days.indexOf(3) >= 0
        day4.checked = days.indexOf(4) >= 0
        day5.checked = days.indexOf(5) >= 0
        day6.checked = days.indexOf(6) >= 0
    }

    function selectedDays() {
        const values = []
        if (day0.checked) values.push(0)
        if (day1.checked) values.push(1)
        if (day2.checked) values.push(2)
        if (day3.checked) values.push(3)
        if (day4.checked) values.push(4)
        if (day5.checked) values.push(5)
        if (day6.checked) values.push(6)
        return values.length > 0 ? values : [0,1,2,3,4,5,6]
    }

    function save() {
        if (!queue.id)
            return

        const updated = {
            id: String(queue.id),
            name: nameField.text.trim().length > 0
                ? nameField.text.trim()
                : String(queue.name || queue.id),
            active: boolValue("active", false),
            scheduled: scheduledCheck.checked,
            scheduleType: scheduleType.currentIndex === 0
                ? "once"
                : scheduleType.currentIndex === 2 ? "custom" : "daily",
            maxActive: maxActive.value,
            scheduleCompleted: false,
            startTime: startTime.text.trim().length > 0 ? startTime.text.trim() : "02:00",
            endTime: endTime.text.trim().length > 0 ? endTime.text.trim() : "08:00",
            days: scheduleType.currentIndex === 0
                ? [new Date().getDay()]
                : scheduleType.currentIndex === 1
                    ? [0,1,2,3,4,5,6]
                    : selectedDays(),
            limitSpeed: limitSpeed.checked,
            speedLimitKbs: speedLimit.value,
            oneTimeLimit: oneTimeLimit.checked,
            shutdownOnComplete: shutdownCheck.checked,
            hangupOnComplete: sleepCheck.checked,
            exitOnComplete: exitCheck.checked,
            retryCount: retryCount.value,
            retryDelay: retryDelay.value,
            profileId: profileBox.currentIndex >= 0
                ? String(profileBox.currentValue || "")
                : ""
        }
        api.updateQueue(updated)
    }

    onQueueChanged: load()
    Component.onCompleted: load()

    Connections {
        target: api
        function onEngineManagementChanged() {
            root.load()
        }
    }

    GridLayout {
        id: form
        anchors.fill: parent
        anchors.margins: 10
        columns: 2
        columnSpacing: 12
        rowSpacing: 9

        Text { text: root.t("queue.name"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
        TextField {
            id: nameField
            Layout.fillWidth: true
            selectByMouse: true
            Accessible.name: root.t("queue.name")
        }

        Text { text: root.t("queue.schedule"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
        RowLayout {
            Layout.fillWidth: true
            CheckBox {
                id: scheduledCheck
                text: root.t("queue.enabled")
            }
            ComboBox {
                id: scheduleType
                Layout.fillWidth: true
                enabled: scheduledCheck.checked
                model: [
                    root.t("queue.once"),
                    root.t("queue.daily"),
                    root.t("queue.custom")
                ]
            }
        }

        Text { text: root.t("queue.timeWindow"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
        RowLayout {
            Layout.fillWidth: true
            TextField {
                id: startTime
                Layout.fillWidth: true
                placeholderText: "02:00"
                enabled: scheduledCheck.checked
                LayoutMirroring.enabled: false
                horizontalAlignment: Text.AlignLeft
            }
            Text { text: "→"; color: Theme.textMuted }
            TextField {
                id: endTime
                Layout.fillWidth: true
                placeholderText: "08:00"
                enabled: scheduledCheck.checked
                LayoutMirroring.enabled: false
                horizontalAlignment: Text.AlignLeft
            }
        }

        Text { text: root.t("queue.days"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
        RowLayout {
            Layout.fillWidth: true
            enabled: scheduledCheck.checked && scheduleType.currentIndex === 2
            CheckBox { id: day0; text: root.t("queue.sun") }
            CheckBox { id: day1; text: root.t("queue.mon") }
            CheckBox { id: day2; text: root.t("queue.tue") }
            CheckBox { id: day3; text: root.t("queue.wed") }
            CheckBox { id: day4; text: root.t("queue.thu") }
            CheckBox { id: day5; text: root.t("queue.fri") }
            CheckBox { id: day6; text: root.t("queue.sat") }
        }

        Text { text: root.t("queue.maxActive"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
        SpinBox {
            id: maxActive
            from: 1
            to: 64
            value: 1
        }

        Text { text: root.t("queue.speedLimit"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
        RowLayout {
            Layout.fillWidth: true
            CheckBox {
                id: limitSpeed
                text: root.t("queue.limitSpeed")
            }
            SpinBox {
                id: speedLimit
                from: 0
                to: 10000000
                value: 1024
                enabled: limitSpeed.checked
            }
            Text { text: "KB/s"; color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
        }

        Text { text: root.t("queue.oneTimeLimit"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
        CheckBox {
            id: oneTimeLimit
            text: root.t("queue.oneTimeLimitHint")
        }

        Text { text: root.t("queue.engineProfile"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
        ComboBox {
            id: profileBox
            Layout.fillWidth: true
            model: api.engineProfiles
            textRole: "name"
            valueRole: "id"
            enabled: api.engineProfiles.length > 0
            Accessible.name: root.t("queue.engineProfile")
        }

        Text { text: root.t("queue.retries"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
        RowLayout {
            SpinBox {
                id: retryCount
                from: 1
                to: 9999
                value: 3
            }
            Text { text: root.t("queue.retryDelay"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
            SpinBox {
                id: retryDelay
                from: 1
                to: 86400
                value: 10
            }
            Text { text: root.t("queue.seconds"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
        }

        Text { text: root.t("queue.completionActions"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
        Flow {
            Layout.fillWidth: true
            spacing: 8
            CheckBox { id: shutdownCheck; text: root.t("queue.shutdown") }
            CheckBox { id: sleepCheck; text: root.t("queue.sleep") }
            CheckBox { id: exitCheck; text: root.t("queue.exit") }
        }

        Item { Layout.fillWidth: true }
        RowLayout {
            Layout.alignment: Qt.AlignRight
            Button {
                text: root.t("queue.reload")
                onClicked: root.load()
            }
            Button {
                text: root.t("queue.save")
                enabled: Boolean(root.queue && root.queue.id)
                onClicked: root.save()
            }
        }
    }
}
