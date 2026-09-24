import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var api
    required property var downloads

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

    function formatKbps(value) {
        if (!value || value <= 0) return "Unlimited"
        if (value >= 1024)
            return (value / 1024).toFixed(1) + " MB/s"
        return value + " KB/s"
    }

    function taskInfo(taskId) {
        const item = downloads.itemById(taskId)
        return item && item.taskId ? item : ({})
    }

    function priorityIndex(priority) {
        if (priority === "Critical") return 0
        if (priority === "High") return 1
        if (priority === "Low") return 3
        if (priority === "Background") return 4
        return 2
    }

    Component.onCompleted: api.refreshQueue()

    Timer {
        interval: 5000
        repeat: true
        running: root.visible
        onTriggered: api.refreshQueue()
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
                    text: "Queue Manager"
                    color: Theme.textPrimary
                    font.pixelSize: 21
                    font.weight: Font.DemiBold
                }
                Text {
                    text: "Priority and bandwidth allocation from the NOVA engine queue"
                    color: Theme.textMuted
                    font.pixelSize: 10
                }
            }

            Item { Layout.fillWidth: true }

            Button {
                text: "Refresh"
                onClicked: api.refreshQueue()
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            Repeater {
                model: [
                    { label: "Queued entries", value: String(api.queueEntries.length) },
                    { label: "Active", value: String(api.queueActiveCount) },
                    { label: "Global bandwidth", value: root.formatKbps(api.queueTotalBandwidthKbps) },
                    { label: "Next to start", value: api.nextQueuedTask.length > 0 ? api.nextQueuedTask : "—" }
                ]

                delegate: Rectangle {
                    required property var modelData
                    Layout.fillWidth: true
                    Layout.preferredHeight: 66
                    radius: Theme.radiusMedium
                    color: Theme.surface
                    border.color: Theme.border

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: 10
                        spacing: 2

                        Text {
                            text: modelData.label
                            color: Theme.textMuted
                            font.pixelSize: 9
                            font.weight: Font.DemiBold
                        }

                        Text {
                            Layout.fillWidth: true
                            text: modelData.value
                            color: Theme.textPrimary
                            font.pixelSize: 14
                            font.weight: Font.DemiBold
                            elide: Text.ElideMiddle
                        }
                    }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border
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

                        Text { Layout.fillWidth: true; text: "Download"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                        Text { Layout.preferredWidth: 80; text: "Position"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                        Text { Layout.preferredWidth: 100; text: "Size"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                        Text { Layout.preferredWidth: 120; text: "Allocated"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                        Text { Layout.preferredWidth: 150; text: "Priority"; color: Theme.textSecondary; font.pixelSize: 10; font.weight: Font.DemiBold }
                    }
                }

                ListView {
                    id: queueList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    model: api.queueEntries
                    ScrollBar.vertical: ScrollBar {}

                    delegate: Rectangle {
                        id: queueRow
                        required property var modelData
                        width: queueList.width
                        height: 52
                        color: mouse.containsMouse ? Theme.surfaceHover : "transparent"

                        readonly property var info: root.taskInfo(modelData.task_id)

                        Rectangle {
                            anchors.bottom: parent.bottom
                            width: parent.width
                            height: 1
                            color: Theme.border
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
                                    text: queueRow.info.name || modelData.task_id
                                    color: Theme.textPrimary
                                    font.pixelSize: 11
                                    font.weight: Font.Medium
                                    elide: Text.ElideMiddle
                                }

                                Text {
                                    Layout.fillWidth: true
                                    text: queueRow.info.status || modelData.task_id
                                    color: Theme.textMuted
                                    font.pixelSize: 9
                                    elide: Text.ElideRight
                                }
                            }

                            Text {
                                Layout.preferredWidth: 80
                                text: "#" + (Number(modelData.position) + 1)
                                color: Theme.textSecondary
                                font.pixelSize: 10
                                font.family: "monospace"
                            }

                            Text {
                                Layout.preferredWidth: 100
                                text: root.formatBytes(Number(modelData.size_bytes))
                                color: Theme.textSecondary
                                font.pixelSize: 10
                                font.family: "monospace"
                            }

                            Text {
                                Layout.preferredWidth: 120
                                text: root.formatKbps(Number(modelData.allocated_kbps))
                                color: Number(modelData.allocated_kbps) > 0 ? Theme.textPrimary : Theme.textMuted
                                font.pixelSize: 10
                                font.family: "monospace"
                            }

                            ComboBox {
                                Layout.preferredWidth: 150
                                model: ["Critical", "High", "Normal", "Low", "Background"]
                                currentIndex: root.priorityIndex(modelData.priority)
                                enabled: root.api.connected
                                onActivated: index => root.api.setQueuePriority(modelData.task_id, index)
                            }
                        }

                        MouseArea {
                            id: mouse
                            anchors.fill: parent
                            acceptedButtons: Qt.NoButton
                            hoverEnabled: true
                        }
                    }
                }
            }

            ColumnLayout {
                anchors.centerIn: parent
                visible: api.queueEntries.length === 0
                spacing: 6

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "Queue is empty"
                    color: Theme.textPrimary
                    font.pixelSize: 16
                    font.weight: Font.DemiBold
                }

                Text {
                    text: "Queued and active engine tasks will appear here."
                    color: Theme.textMuted
                    font.pixelSize: 10
                }
            }
        }
    }
}
