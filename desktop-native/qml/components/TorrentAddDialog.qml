import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Dialog {
    id: root

    required property var api
    required property var desktop
    required property var settings
    property string languageToken: i18n.language
    property var review: ({})
    property string localFilePath: ""
    property string destinationPath: ""
    property var priorities: []
    property string loadedAnalysisId: ""
    property string errorText: ""
    property string ratioLimit: ""
    property string timeLimitMinutes: ""
    property int connections: 8
    property bool seedingEnabled: true
    property bool allowDuplicate: false
    property bool creating: false
    property bool discarding: false

    readonly property string reviewId: String(review.reviewId || "")
    readonly property bool isCaptureReview: reviewId.length > 0
    readonly property var analysis: api.torrentAnalysis || ({})
    readonly property var torrentFiles: analysis.files || []
    readonly property bool analysisReady: String(analysis.analysisId || "").length > 0
    readonly property var priorityIds: ["high", "normal", "skip"]
    readonly property int selectedFileCount: {
        let count = 0
        for (let i = 0; i < torrentFiles.length; ++i) {
            if (root.filePriority(i) !== "skip")
                ++count
        }
        return count
    }
    readonly property double selectedBytes: {
        let total = 0
        for (let i = 0; i < torrentFiles.length; ++i) {
            if (root.filePriority(i) !== "skip")
                total += Number(torrentFiles[i].length || 0)
        }
        return total
    }

    modal: true
    focus: true
    closePolicy: Popup.NoAutoClose
    width: Math.min(820, parent ? parent.width - 48 : 820)
    height: Math.min(760, parent ? parent.height - 48 : 760)
    title: root.isCaptureReview ? root.t("torrent.reviewTitle") : root.t("torrent.addTitle")

    function t(key) {
        return i18n.translate(key)
    }

    function openNew() {
        api.clearTorrentAnalysis()
        root.review = ({})
        root.localFilePath = ""
        root.destinationPath = String(settings.defaultSaveDirectory || "")
        root.priorities = []
        root.loadedAnalysisId = ""
        root.errorText = ""
        root.ratioLimit = ""
        root.timeLimitMinutes = ""
        root.connections = Math.max(1, Number(settings.defaultConnections || 8))
        root.seedingEnabled = true
        root.allowDuplicate = false
        root.creating = false
        root.discarding = false
        sourceField.text = ""
        open()
    }

    function openForReview(item) {
        api.clearTorrentAnalysis()
        root.review = item || ({})
        root.localFilePath = ""
        root.destinationPath = String(settings.defaultSaveDirectory || "")
        root.priorities = []
        root.loadedAnalysisId = ""
        root.errorText = ""
        root.ratioLimit = ""
        root.timeLimitMinutes = ""
        root.connections = Math.max(1, Number(settings.defaultConnections || 8))
        root.seedingEnabled = true
        root.allowDuplicate = false
        root.creating = false
        root.discarding = false
        sourceField.text = String(root.review.url || "")
        open()
    }

    function filePriority(index) {
        return root.priorities[index] || "normal"
    }

    function setFilePriority(index, value) {
        const next = root.priorities.slice()
        next[index] = value
        root.priorities = next
    }

    function setAllPriorities(value) {
        const next = []
        for (let i = 0; i < torrentFiles.length; ++i)
            next.push(value)
        root.priorities = next
    }

    function invalidateAnalysis() {
        root.loadedAnalysisId = ""
        root.priorities = []
        root.errorText = ""
        api.clearTorrentAnalysis()
    }

    function analyzeSource() {
        if (api.torrentAnalysisBusy)
            return
        root.errorText = ""
        if (root.isCaptureReview) {
            api.analyzeCaptureReviewTorrent(root.reviewId)
            return
        }
        if (root.localFilePath.length > 0) {
            api.analyzeTorrentFile(root.localFilePath)
            return
        }
        const source = sourceField.text.trim()
        if (source.length === 0) {
            root.errorText = root.t("torrent.sourceRequired")
            return
        }
        if (source.toLowerCase().startsWith("magnet:"))
            api.analyzeTorrentMagnet(source)
        else
            api.analyzeTorrentUrl(source)
    }

    function formatBytes(value) {
        const bytes = Number(value || 0)
        if (bytes >= 1073741824)
            return (bytes / 1073741824).toFixed(2) + " GB"
        if (bytes >= 1048576)
            return (bytes / 1048576).toFixed(1) + " MB"
        if (bytes >= 1024)
            return (bytes / 1024).toFixed(0) + " KB"
        return String(bytes) + " B"
    }

    function selectedPriorities() {
        return root.priorities.slice(0, torrentFiles.length)
    }

    function createTorrent(startImmediately) {
        if (!analysisReady || root.creating)
            return
        if (!destinationPath.trim()) {
            root.errorText = root.t("torrent.chooseDirectory")
            return
        }
        if (selectedFileCount === 0) {
            root.errorText = root.t("torrent.filesRequired")
            return
        }
        if (root.priorities.length !== torrentFiles.length) {
            root.errorText = root.t("torrent.analysisRequired")
            return
        }

        const ratioText = root.ratioLimit.trim()
        const ratio = ratioText.length === 0 ? null : Number(ratioText)
        const minutesText = root.timeLimitMinutes.trim()
        const minutes = minutesText.length === 0 ? null : Number(minutesText)
        if ((ratio !== null && (!isFinite(ratio) || ratio < 0 || ratio > 1000))
            || (minutes !== null && (!isFinite(minutes) || minutes < 1 || minutes > 5256000))) {
            root.errorText = root.t("torrent.invalidSeedingLimit")
            return
        }

        root.creating = true
        root.errorText = ""
        const seeding = {
            enabled: root.seedingEnabled,
            ratioLimit: ratio === null ? null : ratio,
            timeLimitSeconds: minutes === null
                ? null
                : Math.round(minutes * 60)
        }
        api.createTorrent(
            String(analysis.analysisId),
            destinationPath.trim(),
            startImmediately,
            root.selectedPriorities(),
            Math.max(1, Math.min(32, Number(root.connections || 1))),
            seeding,
            root.allowDuplicate,
            root.reviewId
        )
    }

    function discardReview() {
        if (root.reviewId.length === 0) {
            close()
            return
        }
        root.discarding = true
        api.discardCaptureReview(root.reviewId)
    }

    background: Rectangle {
        color: Theme.surfaceRaised
        border.color: Theme.borderStrong
        border.width: 1
        radius: Theme.radiusLarge
    }

    contentItem: ColumnLayout {
        spacing: 10

        RowLayout {
            Layout.fillWidth: true

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 3
                Text {
                    text: root.t("torrent.source")
                    color: Theme.textPrimary
                    font.pixelSize: Math.round(18 * Theme.fontScale)
                    font.weight: Font.DemiBold
                }
                Text {
                    Layout.fillWidth: true
                    text: root.isCaptureReview
                        ? root.t("captureReview.subtitle")
                        : root.t("torrent.sourceHint")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontSmall
                    wrapMode: Text.WordWrap
                }
            }

            Button {
                text: root.api.torrentAnalysisBusy
                    ? root.t("torrent.analyzing")
                    : root.t("torrent.analyze")
                enabled: !root.api.torrentAnalysisBusy && !root.creating
                onClicked: root.analyzeSource()
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            TextField {
                id: sourceField
                Layout.fillWidth: true
                placeholderText: root.t("torrent.sourceHint")
                enabled: !root.api.torrentAnalysisBusy && !root.creating
                readOnly: root.isCaptureReview || root.localFilePath.length > 0
                selectByMouse: true
                Accessible.name: root.t("torrent.source")
                LayoutMirroring.enabled: false
                horizontalAlignment: Text.AlignLeft
                onTextEdited: {
                    root.localFilePath = ""
                    root.invalidateAnalysis()
                }
            }

            Button {
                text: root.t("torrent.chooseFile")
                visible: !root.isCaptureReview
                enabled: !root.api.torrentAnalysisBusy && !root.creating
                onClicked: {
                    const chosen = desktop.chooseOpenFile(
                        root.localFilePath,
                        "BitTorrent files (*.torrent);;All files (*)"
                    )
                    if (chosen.length > 0) {
                        root.invalidateAnalysis()
                        root.localFilePath = chosen
                        sourceField.text = chosen
                        root.errorText = ""
                    }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: errorLabel.implicitHeight + 16
            visible: root.errorText.length > 0
            radius: Theme.radiusMedium
            color: Qt.rgba(0.97, 0.32, 0.29, 0.10)
            border.color: Theme.danger
            Text {
                id: errorLabel
                anchors.fill: parent
                anchors.margins: 8
                text: root.errorText
                color: Theme.danger
                font.pixelSize: Theme.fontSmall
                wrapMode: Text.WordWrap
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: root.analysisReady
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 12
                spacing: 8

                RowLayout {
                    Layout.fillWidth: true
                    Text {
                        Layout.fillWidth: true
                        text: String(root.analysis.name || "")
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontBody
                        font.weight: Font.DemiBold
                        elide: Text.ElideRight
                    }
                    Text {
                        text: root.formatBytes(root.analysis.totalLength)
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontSmall
                    }
                }

                Flow {
                    Layout.fillWidth: true
                    spacing: 12
                    Text {
                        text: root.t("torrent.infoHash") + ": " + String(root.analysis.infoHash || "")
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                        font.family: "monospace"
                    }
                    Text {
                        text: root.t("torrent.files") + ": " + String(root.torrentFiles.length)
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                    }
                    Text {
                        text: root.t("torrent.trackers") + ": " + String(root.analysis.trackerCount || 0)
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                    }
                    Text {
                        text: root.t("torrent.peers") + ": " + String(root.analysis.peerCount || 0)
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                    }
                    Text {
                        visible: Boolean(root.analysis.private)
                        text: root.t("torrent.private")
                        color: Theme.warning
                        font.pixelSize: Theme.fontTiny
                        font.weight: Font.DemiBold
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    Text {
                        Layout.fillWidth: true
                        text: root.t("torrent.fileSelection") + " · "
                            + root.t("torrent.selectedFiles") + ": "
                            + String(root.selectedFileCount) + "/" + String(root.torrentFiles.length)
                            + " · " + root.formatBytes(root.selectedBytes)
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontSmall
                    }
                    ToolButton {
                        text: root.t("torrent.selectAll")
                        onClicked: root.setAllPriorities("normal")
                    }
                    ToolButton {
                        text: root.t("torrent.selectNone")
                        onClicked: root.setAllPriorities("skip")
                    }
                }

                ListView {
                    id: torrentFileList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds
                    model: root.torrentFiles
                    activeFocusOnTab: true
                    keyNavigationEnabled: true
                    keyNavigationWraps: false
                    Accessible.role: Accessible.List
                    Accessible.name: root.t("torrent.fileSelection")
                    Accessible.description: root.t("torrent.selectedFiles") + ": "
                        + String(root.selectedFileCount) + "/" + String(root.torrentFiles.length)
                    onActiveFocusChanged: {
                        if (activeFocus && count > 0 && currentIndex < 0)
                            currentIndex = 0
                    }
                    ScrollBar.vertical: ScrollBar {}

                    delegate: Rectangle {
                        required property int index
                        required property var modelData
                        width: torrentFileList.width
                        height: 40
                        color: "transparent"
                        border.width: torrentFileList.activeFocus
                            && torrentFileList.currentIndex === index ? 2 : 0
                        border.color: Theme.focusRing
                        Accessible.role: Accessible.ListItem
                        Accessible.name: String(modelData.path || String(index + 1))
                        Accessible.description: root.formatBytes(modelData.length) + " · "
                            + root.t("torrent.priority") + ": "
                            + root.t("torrent." + root.filePriority(index))
                        Accessible.focusable: true
                        Accessible.focused: torrentFileList.activeFocus
                            && torrentFileList.currentIndex === index
                        Accessible.selectable: true
                        Accessible.selected: torrentFileList.currentIndex === index
                        Accessible.onPressAction: torrentFileList.currentIndex = index

                        RowLayout {
                            anchors.fill: parent
                            anchors.leftMargin: 4
                            anchors.rightMargin: 4
                            spacing: 8

                            ComboBox {
                                Layout.preferredWidth: 115
                                enabled: !root.creating
                                model: [
                                    root.t("torrent.high"),
                                    root.t("torrent.normal"),
                                    root.t("torrent.skip")
                                ]
                                currentIndex: Math.max(0, root.priorityIds.indexOf(root.filePriority(index)))
                                Accessible.name: root.t("torrent.priority") + ": "
                                    + String(modelData.path || "")
                                onActivated: selectedIndex => {
                                    root.setFilePriority(index, root.priorityIds[selectedIndex])
                                }
                            }

                            Text {
                                Layout.fillWidth: true
                                text: String(modelData.path || "")
                                color: root.filePriority(index) === "skip"
                                    ? Theme.textMuted : Theme.textPrimary
                                font.pixelSize: Theme.fontSmall
                                elide: Text.ElideMiddle
                                Accessible.name: text
                            }

                            Text {
                                Layout.preferredWidth: 85
                                text: root.formatBytes(modelData.length)
                                color: Theme.textMuted
                                font.pixelSize: Theme.fontTiny
                                horizontalAlignment: Text.AlignRight
                            }
                        }
                    }
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            TextField {
                id: destinationField
                Layout.fillWidth: true
                visible: root.analysisReady
                placeholderText: root.t("torrent.chooseDirectory")
                text: root.destinationPath
                onTextEdited: root.destinationPath = text
                selectByMouse: true
                Accessible.name: root.t("torrent.destination")
                LayoutMirroring.enabled: false
                horizontalAlignment: Text.AlignLeft
            }

            Button {
                text: root.t("common.browse")
                visible: root.analysisReady
                enabled: !root.creating
                onClicked: {
                    const chosen = desktop.chooseDirectory(root.destinationPath || settings.defaultSaveDirectory)
                    if (chosen.length > 0)
                        root.destinationPath = chosen
                }
            }
        }

        GridLayout {
            Layout.fillWidth: true
            visible: root.analysisReady
            columns: 4
            columnSpacing: 8
            rowSpacing: 6

            Text {
                text: root.t("torrent.connections")
                color: Theme.textSecondary
                font.pixelSize: Theme.fontSmall
            }
            SpinBox {
                from: 1
                to: 32
                value: root.connections
                onValueModified: root.connections = value
                Accessible.name: root.t("torrent.connections")
            }
            CheckBox {
                text: root.t("torrent.enableSeeding")
                checked: root.seedingEnabled
                onToggled: root.seedingEnabled = checked
                Accessible.name: text
            }
            Item { Layout.fillWidth: true }

            Text {
                text: root.t("torrent.ratioLimit")
                color: Theme.textSecondary
                font.pixelSize: Theme.fontSmall
            }
            TextField {
                Layout.preferredWidth: 90
                text: root.ratioLimit
                placeholderText: root.t("torrent.optional")
                validator: DoubleValidator { bottom: 0; top: 1000; decimals: 3 }
                onTextEdited: root.ratioLimit = text
                Accessible.name: root.t("torrent.ratioLimit")
            }
            Text {
                text: root.t("torrent.timeLimit")
                color: Theme.textSecondary
                font.pixelSize: Theme.fontSmall
            }
            RowLayout {
                Layout.fillWidth: true
                TextField {
                    Layout.preferredWidth: 90
                    text: root.timeLimitMinutes
                    placeholderText: root.t("torrent.optional")
                    validator: IntValidator { bottom: 1; top: 5256000 }
                    onTextEdited: root.timeLimitMinutes = text
                    Accessible.name: root.t("torrent.timeLimit")
                }
                Text {
                    text: root.t("torrent.minutes")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontTiny
                }
            }

            CheckBox {
                Layout.columnSpan: 4
                text: root.t("torrent.allowDuplicate")
                checked: root.allowDuplicate
                enabled: !root.creating
                onToggled: root.allowDuplicate = checked
                Accessible.name: text
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 3

            Button {
                text: root.isCaptureReview ? root.t("captureReview.dismiss") : root.t("common.cancel")
                enabled: !root.creating && !root.discarding && !root.api.torrentAnalysisBusy
                onClicked: root.discardReview()
            }

            Item { Layout.fillWidth: true }

            Button {
                visible: root.analysisReady
                text: root.t("torrent.queue")
                enabled: !root.creating
                    && root.api.controlPlaneCommandSupported("addTorrent")
                    && root.selectedFileCount > 0
                onClicked: root.createTorrent(false)
            }

            Button {
                visible: root.analysisReady
                text: root.creating ? root.t("torrent.adding") : root.t("torrent.start")
                enabled: !root.creating
                    && root.api.controlPlaneCommandSupported("addTorrent")
                    && root.selectedFileCount > 0
                onClicked: root.createTorrent(true)

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
            }
        }
    }

    Connections {
        target: root.api

        function onTorrentAnalysisChanged() {
            const nextId = String(root.api.torrentAnalysis.analysisId || "")
            if (nextId === root.loadedAnalysisId)
                return
            root.loadedAnalysisId = nextId
            root.priorities = nextId.length === 0
                ? []
                : (root.api.torrentAnalysis.files || []).map(file => file.priority || "normal")
            if (nextId.length > 0)
                root.errorText = ""
        }

        function onTorrentAnalysisFailed(message) {
            if (root.visible) {
                root.creating = false
                root.errorText = message
            }
        }

        function onTorrentTaskCreated(taskId) {
            if (!root.visible)
                return
            root.creating = false
            root.close()
        }

        function onTorrentTaskCreationFailed(message) {
            if (!root.visible)
                return
            root.creating = false
            const duplicateBlocked = String(message).toLowerCase().indexOf("already in task") >= 0
            root.errorText = duplicateBlocked ? root.t("torrent.duplicateFound") : message
            if (root.isCaptureReview && !duplicateBlocked) {
                root.invalidateAnalysis()
            }
        }

        function onCaptureReviewDiscarded(reviewId) {
            if (root.isCaptureReview && root.reviewId === reviewId) {
                root.discarding = false
                root.close()
            }
        }

        function onCaptureReviewActionFailed(reviewId, message) {
            if (root.isCaptureReview && root.reviewId === reviewId) {
                root.discarding = false
                root.errorText = message
            }
        }
    }
}
