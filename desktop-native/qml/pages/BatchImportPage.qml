import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var api
    required property var settings
    required property var desktop

    property int totalCount: 0
    property int completedCount: 0
    property int acceptedCount: 0
    property int failedCount: 0
    property int duplicateCount: 0
    property string resultText: ""
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    Component.onCompleted: {
        saveDirectory.text = settings.defaultSaveDirectory
        startImmediately.checked = settings.startImmediately
        for (let i = 0; i < connections.model.length; ++i) {
            if (connections.model[i].value === settings.defaultConnections) {
                connections.currentIndex = i
                break
            }
        }
    }

    function resetProgress() {
        totalCount = 0
        completedCount = 0
        acceptedCount = 0
        failedCount = 0
        duplicateCount = 0
        resultText = ""
    }

    Connections {
        target: api

        function onBatchImportStarted(total, duplicates) {
            root.totalCount = total
            root.completedCount = 0
            root.acceptedCount = 0
            root.failedCount = 0
            root.duplicateCount = duplicates
            root.resultText = ""
        }

        function onBatchImportProgress(completed, total, accepted, failed) {
            root.completedCount = completed
            root.totalCount = total
            root.acceptedCount = accepted
            root.failedCount = failed
        }

        function onBatchImportFinished(total, accepted, failed, duplicates) {
            root.totalCount = total
            root.completedCount = total
            root.acceptedCount = accepted
            root.failedCount = failed
            root.duplicateCount = duplicates
            root.resultText = accepted + " accepted"
                + (failed > 0 ? " · " + failed + " failed" : "")
                + (duplicates > 0 ? " · " + duplicates + " duplicate(s) skipped" : "")
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12

        ColumnLayout {
            spacing: 2

            Text {
                text: root.t("batch.title")
                color: Theme.textPrimary
                font.pixelSize: Theme.fontTitle
                font.weight: Font.DemiBold
            }

            Text {
                text: root.t("batch.subtitle")
                color: Theme.textMuted
                font.pixelSize: Theme.fontSmall
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 44
            radius: Theme.radiusMedium
            color: Theme.accentMuted
            border.color: Theme.border

            Text {
                anchors.fill: parent
                anchors.margins: 10
                text: root.t("batch.hint")
                color: Theme.textSecondary
                font.pixelSize: Theme.fontSmall
                wrapMode: Text.WordWrap
                verticalAlignment: Text.AlignVCenter
            }
        }

        TextArea {
            id: linksInput
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.minimumHeight: 220
            placeholderText: "https://example.com/file1.zip\nhttps://example.com/file2.zip"
            selectByMouse: true
            wrapMode: TextEdit.NoWrap
            font.family: "monospace"
            enabled: !api.batchRunning
            LayoutMirroring.enabled: false
            horizontalAlignment: Text.AlignLeft
            Accessible.name: root.t("batch.title")
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 10

            RowLayout {
                Layout.fillWidth: true
                spacing: 6

                TextField {
                    id: saveDirectory
                    Layout.fillWidth: true
                    placeholderText: root.t("batch.destination")
                    selectByMouse: true
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                    Accessible.name: root.t("common.destination")
                    enabled: !api.batchRunning
                }

                Button {
                    text: root.t("common.browse")
                    enabled: !api.batchRunning
                    onClicked: {
                        const chosen = desktop.chooseDirectory(saveDirectory.text)
                        if (chosen.length > 0)
                            saveDirectory.text = chosen
                    }
                }
            }

            ComboBox {
                id: connections
                Layout.preferredWidth: 150
                model: [
                    { label: "Automatic", value: 0 },
                    { label: "1 connection", value: 1 },
                    { label: "8 connections", value: 8 },
                    { label: "16 connections", value: 16 },
                    { label: "24 connections", value: 24 },
                    { label: "32 connections", value: 32 }
                ]
                textRole: "label"
                valueRole: "value"
                enabled: !api.batchRunning
            }

            CheckBox {
                id: startImmediately
                text: root.t("common.startImmediately")
                checked: false
                enabled: !api.batchRunning
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: progressColumn.implicitHeight + 20
            visible: root.totalCount > 0 || root.resultText.length > 0
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            ColumnLayout {
                id: progressColumn
                anchors.fill: parent
                anchors.margins: 10
                spacing: 6

                ProgressBar {
                    Layout.fillWidth: true
                    from: 0
                    to: Math.max(1, root.totalCount)
                    value: root.completedCount
                }

                RowLayout {
                    Layout.fillWidth: true

                    Text {
                        text: root.completedCount + " / " + root.totalCount
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontSmall
                    }

                    Item { Layout.fillWidth: true }

                    Text {
                        text: root.resultText.length > 0
                            ? root.resultText
                            : root.acceptedCount + " accepted · " + root.failedCount + " failed"
                        color: root.failedCount > 0 ? Theme.warning : Theme.textSecondary
                        font.pixelSize: Theme.fontSmall
                    }
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true

            Button {
                text: root.t("batch.clear")
                enabled: !api.batchRunning
                onClicked: {
                    linksInput.clear()
                    root.resetProgress()
                }
            }

            Item { Layout.fillWidth: true }

            Button {
                text: api.batchRunning ? root.t("batch.importing") : root.t("batch.import")
                enabled: api.connected && !api.batchRunning && linksInput.text.trim().length > 0

                background: Rectangle {
                    radius: Theme.radiusMedium
                    color: parent.enabled ? Theme.accent : Theme.accentMuted
                }

                contentItem: Text {
                    text: parent.text
                    color: parent.enabled ? "white" : Theme.textMuted
                    font.pixelSize: Theme.fontBody
                    font.weight: Font.DemiBold
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }

                onClicked: {
                    root.resetProgress()
                    api.importBatch(
                        linksInput.text,
                        saveDirectory.text,
                        connections.currentValue,
                        startImmediately.checked
                    )
                }
            }
        }
    }
}
