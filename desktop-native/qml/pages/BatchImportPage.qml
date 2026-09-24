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
    property bool advancedExpanded: false
    property string defaultQueueId: "main"
    property var capabilitySnapshot: api.engineCapabilities
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function supportsDirect(key) {
        const snapshot = root.capabilitySnapshot
        return api.directOptionSupported(key)
    }

    Component.onCompleted: {
        saveDirectory.text = settings.defaultSaveDirectory
        startImmediately.checked = settings.startImmediately
        if (api.connected) {
            api.refreshEngineCapabilities()
            api.refreshQueueCatalog()
        }
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

        function onConnectionChanged() {
            if (api.connected) {
                api.refreshEngineCapabilities()
                api.refreshQueueCatalog()
            }
        }

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
            root.resultText = accepted + " " + root.t("batch.accepted")
                + (failed > 0 ? " · " + failed + " " + root.t("batch.failed") : "")
                + (duplicates > 0
                    ? " · " + duplicates + " " + root.t("batch.duplicatesSkipped")
                    : "")
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
            spacing: 8

            Button {
                text: root.t("batch.paste")
                enabled: !api.batchRunning
                onClicked: {
                    const clipboardText = desktop.readClipboardText().trim()
                    if (clipboardText.length === 0)
                        return
                    linksInput.text = linksInput.text.trim().length > 0
                        ? linksInput.text + "\n" + clipboardText
                        : clipboardText
                }
            }

            Item { Layout.fillWidth: true }

            Text {
                id: batchPreview
                property var preview: api.batchExpansionPreview(linksInput.text)

                text: preview.overflow
                    ? root.t("batch.tooMany")
                    : root.t("batch.expanded") + ": " + preview.count
                color: preview.overflow ? Theme.danger : Theme.textSecondary
                font.pixelSize: Theme.fontSmall
                Accessible.name: text
            }
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
                    { label: root.t("batch.automatic"), value: 0 },
                    { label: "1 " + root.t("batch.connection"), value: 1 },
                    { label: "8 " + root.t("batch.connections"), value: 8 },
                    { label: "16 " + root.t("batch.connections"), value: 16 },
                    { label: "24 " + root.t("batch.connections"), value: 24 },
                    { label: "32 " + root.t("batch.connections"), value: 32 }
                ]
                textRole: "label"
                valueRole: "value"
                enabled: !api.batchRunning
                    && root.supportsDirect("segmented")
                    && root.supportsDirect("range")
            }

            CheckBox {
                id: startImmediately
                text: root.t("common.startImmediately")
                checked: false
                enabled: !api.batchRunning
            }
        }

        RowLayout {
            Layout.fillWidth: true

            Button {
                text: root.t("batch.advanced") + (root.advancedExpanded ? " ▲" : " ▼")
                enabled: !api.batchRunning
                onClicked: root.advancedExpanded = !root.advancedExpanded
            }

            Item { Layout.fillWidth: true }
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: advancedGrid.implicitHeight + 20
            visible: root.advancedExpanded
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            GridLayout {
                id: advancedGrid
                anchors.fill: parent
                anchors.margins: 10
                columns: 4
                columnSpacing: 10
                rowSpacing: 8

                Text {
                    text: root.t("batch.queueId")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                }

                ComboBox {
                    id: queueSelector
                    Layout.fillWidth: true
                    model: api.queueCatalog
                    textRole: "name"
                    valueRole: "id"
                    editable: true
                    enabled: !api.batchRunning
                    Accessible.name: root.t("batch.queueId")
                }

                Text {
                    text: root.t("batch.retries")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                }

                SpinBox {
                    id: retryCountField
                    from: 0
                    to: 100
                    value: 3
                    enabled: !api.batchRunning
                        && root.supportsDirect("retryCount")
                }

                Text {
                    text: root.t("batch.referer")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                }

                TextField {
                    id: refererField
                    Layout.columnSpan: 3
                    Layout.fillWidth: true
                    enabled: !api.batchRunning
                        && root.supportsDirect("referer")
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text {
                    text: root.t("batch.userAgent")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                }

                TextField {
                    id: userAgentField
                    Layout.columnSpan: 3
                    Layout.fillWidth: true
                    enabled: !api.batchRunning
                        && root.supportsDirect("userAgent")
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text {
                    text: root.t("batch.timeout")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                }

                SpinBox {
                    id: timeoutField
                    from: 0
                    to: 3600
                    value: 60
                    enabled: !api.batchRunning
                        && root.supportsDirect("timeoutSec")
                }

                Item { Layout.columnSpan: 2; Layout.fillWidth: true }

                Text {
                    text: root.t("batch.proxy")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                }

                TextField {
                    id: proxyField
                    Layout.columnSpan: 3
                    Layout.fillWidth: true
                    placeholderText: root.t("batch.proxyHint")
                    enabled: !api.batchRunning
                        && root.supportsDirect("proxy")
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text {
                    text: root.t("batch.headers")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                }

                TextArea {
                    id: headersField
                    Layout.columnSpan: 3
                    Layout.fillWidth: true
                    Layout.preferredHeight: 72
                    placeholderText: root.t("batch.headersHint")
                    enabled: !api.batchRunning
                        && root.supportsDirect("headers")
                    wrapMode: TextEdit.NoWrap
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text {
                    text: root.t("batch.cookies")
                    color: Theme.textSecondary
                    font.pixelSize: Theme.fontSmall
                }

                TextField {
                    id: cookiesField
                    Layout.columnSpan: 3
                    Layout.fillWidth: true
                    placeholderText: root.t("batch.cookiesHint")
                    enabled: !api.batchRunning
                        && root.supportsDirect("cookies")
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }
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
                            : root.acceptedCount + " " + root.t("batch.accepted")
                                + " · " + root.failedCount + " " + root.t("batch.failed")
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
                enabled: api.connected
                    && api.engineCapabilities.directReady === true
                    && !api.batchRunning
                    && linksInput.text.trim().length > 0
                    && !batchPreview.preview.overflow

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
                    const advanced = {
                        retryCount: retryCountField.value,
                        timeoutSec: timeoutField.value
                    }
                    if (refererField.text.trim().length > 0)
                        advanced.referer = refererField.text.trim()
                    if (userAgentField.text.trim().length > 0)
                        advanced.userAgent = userAgentField.text.trim()
                    if (proxyField.text.trim().length > 0)
                        advanced.proxy = proxyField.text.trim()
                    if (headersField.text.trim().length > 0)
                        advanced.headers = headersField.text.trim()
                    if (cookiesField.text.trim().length > 0)
                        advanced.cookies = cookiesField.text.trim()

                    const selectedQueueId = queueSelector.currentIndex >= 0
                        ? String(queueSelector.currentValue)
                        : queueSelector.editText.trim()

                    api.importBatch(
                        linksInput.text,
                        saveDirectory.text,
                        connections.currentValue,
                        startImmediately.checked,
                        {
                            queueId: selectedQueueId.length > 0
                                ? selectedQueueId
                                : root.defaultQueueId,
                            advanced: advanced
                        }
                    )
                }
            }
        }
    }
}
