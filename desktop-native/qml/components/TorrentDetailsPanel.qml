import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var api
    property var downloadItem: ({})
    property bool active: false
    property string languageToken: i18n.language
    property string trackedTaskId: ""
    property var filePriorities: []
    property bool filePrioritiesEdited: false
    property bool seedingEnabled: true
    property string ratioLimit: ""
    property string timeLimitMinutes: ""
    property bool applyingFiles: false
    property bool applyingSeeding: false
    property bool reauthorizing: false
    property bool seedingPolicyEdited: false
    property string trackerMagnetUri: ""
    property bool revealTrackerMagnet: false
    property string errorText: ""

    readonly property string taskId: String(downloadItem.taskId || "")
    readonly property string status: String(downloadItem.status || "").toLowerCase()
    readonly property bool isTorrent: String(downloadItem.engine || "") === "native-torrent"
        || String(downloadItem.category || "").toLowerCase() === "torrent"
        || String(downloadItem.fileType || "").toLowerCase() === "torrent"
    readonly property var details: api.torrentDetails || ({})
    readonly property var files: details.files || []
    readonly property var trackers: details.trackerTelemetry || []
    readonly property var peers: details.swarmPeers || []
    readonly property bool detailsReady: isTorrent
        && taskId.length > 0
        && String(api.torrentDetailsTaskId || "") === taskId
        && String(details.infoHash || "").length > 0
    readonly property bool canChangeFiles: status === "queued"
        || status === "paused" || status === "failed" || status === "error"
        || status === "interrupted"
    readonly property bool fileSelectionDirty: {
        if (!root.detailsReady || !root.filePrioritiesEdited
            || root.filePriorities.length !== root.files.length)
            return false
        for (let i = 0; i < root.files.length; ++i) {
            if (root.filePriorities[i] !== String(root.files[i].priority || "normal"))
                return true
        }
        return false
    }
    readonly property bool seedingPolicyDirty: {
        if (!root.detailsReady || !root.seedingPolicyEdited)
            return false
        if (root.seedingEnabled !== Boolean(root.details.seedingEnabled))
            return true
        const ratioText = root.ratioLimit.trim()
        const currentRatio = root.details.seedRatioLimit
        if ((ratioText.length === 0) !== (currentRatio === null || currentRatio === undefined))
            return true
        if (ratioText.length > 0 && Math.abs(Number(ratioText) - Number(currentRatio)) > 0.0005)
            return true
        const timeText = root.timeLimitMinutes.trim()
        const currentSeconds = root.details.seedTimeLimitSeconds
        if ((timeText.length === 0) !== (currentSeconds === null || currentSeconds === undefined))
            return true
        return timeText.length > 0
            && Math.abs(Number(timeText) * 60 - Number(currentSeconds)) > 1
    }

    function t(key) {
        return i18n.translate(key)
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

    function formatRatio(value) {
        return Number(value || 0).toFixed(3)
    }

    function filePriority(index) {
        return root.filePriorities[index]
            || String(root.files[index].priority || "normal")
    }

    function setFilePriority(index, value) {
        const next = root.filePriorities.slice()
        next[index] = value
        root.filePriorities = next
        root.filePrioritiesEdited = true
    }

    function syncFromDetails() {
        if (!root.detailsReady)
            return
        if (!root.filePrioritiesEdited || root.applyingFiles) {
            root.filePriorities = root.files.map(file => String(file.priority || "normal"))
            root.filePrioritiesEdited = false
        }
        if (!root.seedingPolicyEdited || root.applyingSeeding) {
            root.seedingEnabled = Boolean(root.details.seedingEnabled)
            root.ratioLimit = root.details.seedRatioLimit === null
                || root.details.seedRatioLimit === undefined
                ? "" : String(root.details.seedRatioLimit)
            root.timeLimitMinutes = root.details.seedTimeLimitSeconds === null
                || root.details.seedTimeLimitSeconds === undefined
                ? "" : String(Math.ceil(Number(root.details.seedTimeLimitSeconds) / 60))
            root.seedingPolicyEdited = false
        }
    }

    function handleItemChanged() {
        if (root.taskId === root.trackedTaskId)
            return
        root.trackedTaskId = root.taskId
        root.filePriorities = []
        root.filePrioritiesEdited = false
        root.errorText = ""
        root.applyingFiles = false
        root.applyingSeeding = false
        root.reauthorizing = false
        root.trackerMagnetUri = ""
        root.revealTrackerMagnet = false
        root.seedingPolicyEdited = false
        if (root.isTorrent && root.taskId.length > 0) {
            root.ratioLimit = ""
            root.timeLimitMinutes = ""
            root.api.refreshTorrentDetails(root.taskId)
        } else {
            root.api.clearTorrentDetails()
        }
    }

    function applyFilePriorities() {
        if (!root.detailsReady || !root.fileSelectionDirty || !root.canChangeFiles
            || root.applyingFiles || root.filePriorities.length !== root.files.length) {
            return
        }
        root.applyingFiles = true
        root.errorText = ""
        root.api.updateTorrentFilePriorities(root.taskId, root.filePriorities)
    }

    function applySeedingPolicy() {
        if (!root.detailsReady || !root.seedingPolicyDirty || root.applyingSeeding)
            return
        const ratioText = root.ratioLimit.trim()
        const ratio = ratioText.length === 0 ? null : Number(ratioText)
        const minutesText = root.timeLimitMinutes.trim()
        const minutes = minutesText.length === 0 ? null : Number(minutesText)
        if ((ratio !== null && (!isFinite(ratio) || ratio < 0 || ratio > 1000))
            || (minutes !== null && (!isFinite(minutes) || minutes < 1 || minutes > 5256000))) {
            root.errorText = root.t("torrent.invalidSeedingLimit")
            return
        }
        root.applyingSeeding = true
        root.errorText = ""
        root.api.updateTorrentSeedingPolicy(root.taskId, {
            enabled: root.seedingEnabled,
            ratioLimit: ratio,
            timeLimitSeconds: minutes === null ? null : Math.round(minutes * 60)
        })
    }

    Component.onCompleted: root.handleItemChanged()
    onDownloadItemChanged: root.handleItemChanged()

    Timer {
        interval: 2000
        repeat: true
        running: root.active && root.isTorrent && root.api.connected
        onTriggered: {
            if (!root.applyingFiles && !root.applyingSeeding)
                root.api.refreshTorrentDetails(root.taskId)
        }
    }

    ScrollView {
        anchors.fill: parent
        clip: true

        ColumnLayout {
            width: parent.availableWidth
            spacing: 10
            leftPadding: 12
            rightPadding: 12
            topPadding: 12
            bottomPadding: 12

            RowLayout {
                Layout.fillWidth: true
                Text {
                    Layout.fillWidth: true
                    text: root.t("torrent.statusTitle")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontBody
                    font.weight: Font.DemiBold
                }
                ToolButton {
                    text: "↻"
                    enabled: root.isTorrent && root.api.connected && !root.api.torrentDetailsBusy
                    Accessible.name: root.t("action.refresh")
                    onClicked: root.api.refreshTorrentDetails(root.taskId)
                }
            }

            Text {
                Layout.fillWidth: true
                visible: !root.isTorrent
                text: root.t("torrent.notTorrent")
                color: Theme.textMuted
                font.pixelSize: Theme.fontSmall
                wrapMode: Text.WordWrap
            }

            Text {
                Layout.fillWidth: true
                visible: root.isTorrent && !root.detailsReady && root.api.connected
                text: root.api.torrentDetailsBusy
                    ? root.t("torrent.refreshing") : root.t("torrent.detailsUnavailable")
                color: Theme.textMuted
                font.pixelSize: Theme.fontSmall
                wrapMode: Text.WordWrap
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

            ColumnLayout {
                Layout.fillWidth: true
                visible: root.detailsReady
                spacing: 10

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: swarmGrid.implicitHeight + 20
                    radius: Theme.radiusMedium
                    color: Theme.surfaceRaised
                    border.color: Theme.border
                    GridLayout {
                        id: swarmGrid
                        anchors.fill: parent
                        anchors.margins: 10
                        columns: 2
                        columnSpacing: 12
                        rowSpacing: 7

                        Text { text: root.t("torrent.infoHash"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                        Text {
                            Layout.fillWidth: true
                            text: String(root.details.infoHash || "—")
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontTiny
                            font.family: "monospace"
                            elide: Text.ElideMiddle
                        }
                        Text { text: root.t("torrent.verifiedPieces"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                        Text {
                            text: String(root.details.verifiedPieces || 0) + "/" + String(root.details.pieceCount || 0)
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontTiny
                            font.family: "monospace"
                        }
                        Text { text: root.t("torrent.selectedCompleted"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                        Text {
                            text: root.formatBytes(root.details.selectedCompletedBytes)
                                + " / " + root.formatBytes(root.details.selectedTotalBytes)
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontTiny
                        }
                        Text { text: root.t("torrent.uploaded"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                        Text {
                            text: root.formatBytes(root.details.uploadedBytes)
                                + " · " + root.formatRatio(root.details.seedRatio)
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontTiny
                        }
                        Text { text: root.t("torrent.seeding"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                        Text {
                            text: root.details.requiresReauth
                                ? root.t("torrent.requiresReauth")
                                : root.details.seedingActive
                                    ? root.t("torrent.seedingActive")
                                    : root.details.seedingEnabled
                                        ? root.t("torrent.seedingEnabled")
                                        : root.t("torrent.seedingDisabled")
                            color: root.details.requiresReauth ? Theme.warning : Theme.textPrimary
                            font.pixelSize: Theme.fontTiny
                        }
                        Text { text: root.t("torrent.swarmPeers"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                        Text {
                            text: String(root.details.trackerPeerCount || 0) + " / "
                                + String(root.details.dhtPeerCount || 0) + " / "
                                + String(root.details.pexPeerCount || 0)
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontTiny
                            font.family: "monospace"
                        }
                        Text { text: root.t("torrent.dht"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                        Text {
                            text: String(root.details.dhtIpv4Port || "—") + " / "
                                + String(root.details.dhtIpv6Port || "—") + " · "
                                + String(root.details.dhtRoutingNodes || 0)
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontTiny
                            font.family: "monospace"
                        }
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    visible: root.details.requiresReauth
                    spacing: 6
                    Text {
                        Layout.fillWidth: true
                        text: root.t("torrent.reauthorizationHint")
                        color: Theme.warning
                        font.pixelSize: Theme.fontTiny
                        wrapMode: Text.WordWrap
                    }
                    TextField {
                        Layout.fillWidth: true
                        text: root.trackerMagnetUri
                        placeholderText: root.t("torrent.reauthorizationPlaceholder")
                        echoMode: root.revealTrackerMagnet ? TextInput.Normal : TextInput.Password
                        selectByMouse: true
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                        enabled: !root.reauthorizing
                        Accessible.name: root.t("torrent.reauthorizationPlaceholder")
                        onTextEdited: root.trackerMagnetUri = text
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        CheckBox {
                            Layout.fillWidth: true
                            text: root.t("torrent.revealTrackerMagnet")
                            checked: root.revealTrackerMagnet
                            onToggled: root.revealTrackerMagnet = checked
                        }
                        Button {
                            text: root.reauthorizing
                                ? root.t("torrent.reauthorizing")
                                : root.t("torrent.reauthorize")
                            enabled: !root.reauthorizing
                                && root.trackerMagnetUri.trim().toLowerCase().startsWith("magnet:")
                            onClicked: {
                                root.reauthorizing = true
                                root.errorText = ""
                                root.api.reauthorizeTorrentTask(root.taskId, root.trackerMagnetUri)
                            }
                        }
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    Text {
                        Layout.fillWidth: true
                        text: root.t("torrent.fileSelection")
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.DemiBold
                    }
                    Button {
                        text: root.t("torrent.applyFiles")
                        visible: root.fileSelectionDirty
                        enabled: root.canChangeFiles && !root.applyingFiles
                        onClicked: root.applyFilePriorities()
                    }
                }

                Text {
                    Layout.fillWidth: true
                    visible: !root.canChangeFiles && root.detailsReady
                    text: root.status === "completed"
                        ? root.t("torrent.completedFilesFixed")
                        : root.t("torrent.pauseToEditFiles")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontTiny
                    wrapMode: Text.WordWrap
                }

                ListView {
                    id: fileList
                    Layout.fillWidth: true
                    Layout.preferredHeight: Math.min(250, contentHeight)
                    visible: root.detailsReady && root.files.length > 0
                    clip: true
                    model: root.files
                    boundsBehavior: Flickable.StopAtBounds
                    activeFocusOnTab: true
                    keyNavigationEnabled: true
                    keyNavigationWraps: false
                    Accessible.role: Accessible.List
                    Accessible.name: root.t("torrent.fileSelection")
                    onActiveFocusChanged: {
                        if (activeFocus && count > 0 && currentIndex < 0)
                            currentIndex = 0
                    }
                    ScrollBar.vertical: ScrollBar {}

                    delegate: Rectangle {
                        required property int index
                        required property var modelData
                        width: fileList.width
                        height: 38
                        color: "transparent"
                        border.width: fileList.activeFocus && fileList.currentIndex === index ? 2 : 0
                        border.color: Theme.focusRing
                        Accessible.role: Accessible.ListItem
                        Accessible.name: String(modelData.path || String(index + 1))
                        Accessible.description: root.formatBytes(modelData.length) + " · "
                            + root.t("torrent.priority") + ": "
                            + root.t("torrent." + root.filePriority(index))
                        Accessible.focusable: true
                        Accessible.focused: fileList.activeFocus && fileList.currentIndex === index
                        Accessible.selectable: true
                        Accessible.selected: fileList.currentIndex === index
                        Accessible.onPressAction: fileList.currentIndex = index

                        RowLayout {
                            anchors.fill: parent
                            anchors.leftMargin: 4
                            anchors.rightMargin: 4
                            spacing: 6

                            ComboBox {
                                Layout.preferredWidth: 92
                                enabled: root.canChangeFiles && !root.applyingFiles
                                model: [root.t("torrent.high"), root.t("torrent.normal"), root.t("torrent.skip")]
                                currentIndex: Math.max(0, ["high", "normal", "skip"].indexOf(root.filePriority(index)))
                                Accessible.name: root.t("torrent.priority") + ": "
                                    + String(modelData.path || "")
                                onActivated: selectedIndex => {
                                    root.setFilePriority(index, ["high", "normal", "skip"][selectedIndex])
                                }
                            }

                            Text {
                                Layout.fillWidth: true
                                text: String(modelData.path || "")
                                color: root.filePriority(index) === "skip" ? Theme.textMuted : Theme.textPrimary
                                font.pixelSize: Theme.fontTiny
                                elide: Text.ElideMiddle
                            }

                            Text {
                                Layout.preferredWidth: 68
                                text: root.formatBytes(modelData.length)
                                color: Theme.textMuted
                                font.pixelSize: Theme.fontTiny
                                horizontalAlignment: Text.AlignRight
                            }
                        }
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    Text {
                        Layout.fillWidth: true
                        text: root.t("torrent.seedingPolicy")
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.DemiBold
                    }
                    Button {
                        text: root.t("torrent.savePolicy")
                        visible: root.seedingPolicyDirty
                        enabled: !root.applyingSeeding
                        onClicked: root.applySeedingPolicy()
                    }
                }

                GridLayout {
                    Layout.fillWidth: true
                    columns: 4
                    columnSpacing: 8
                    rowSpacing: 6
                    CheckBox {
                        Layout.columnSpan: 4
                        text: root.t("torrent.enableSeeding")
                        checked: root.seedingEnabled
                        enabled: !root.applyingSeeding
                        onToggled: {
                            root.seedingEnabled = checked
                            root.seedingPolicyEdited = true
                        }
                    }
                    Text { text: root.t("torrent.ratioLimit"); color: Theme.textSecondary; font.pixelSize: Theme.fontTiny }
                    TextField {
                        Layout.preferredWidth: 85
                        text: root.ratioLimit
                        placeholderText: root.t("torrent.optional")
                        validator: DoubleValidator { bottom: 0; top: 1000; decimals: 3 }
                        enabled: !root.applyingSeeding
                        onTextEdited: {
                            root.ratioLimit = text
                            root.seedingPolicyEdited = true
                        }
                        Accessible.name: root.t("torrent.ratioLimit")
                    }
                    Text { text: root.t("torrent.timeLimit"); color: Theme.textSecondary; font.pixelSize: Theme.fontTiny }
                    RowLayout {
                        TextField {
                            Layout.preferredWidth: 75
                            text: root.timeLimitMinutes
                            placeholderText: root.t("torrent.optional")
                            validator: IntValidator { bottom: 1; top: 5256000 }
                            enabled: !root.applyingSeeding
                            onTextEdited: {
                                root.timeLimitMinutes = text
                                root.seedingPolicyEdited = true
                            }
                            Accessible.name: root.t("torrent.timeLimit")
                        }
                        Text { text: root.t("torrent.minutes"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 5
                    visible: root.trackers.length > 0
                    Text {
                        text: root.t("torrent.trackers")
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.DemiBold
                    }
                    Repeater {
                        model: root.trackers.slice(0, 8)
                        delegate: RowLayout {
                            required property var modelData
                            Layout.fillWidth: true
                            Text {
                                Layout.fillWidth: true
                                text: String(modelData.endpoint || "")
                                color: Theme.textMuted
                                font.pixelSize: Theme.fontTiny
                                elide: Text.ElideMiddle
                            }
                            Text {
                                text: String(modelData.state || "—") + " · " + String(modelData.peerCount || 0)
                                color: Theme.textSecondary
                                font.pixelSize: Theme.fontTiny
                            }
                        }
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 5
                    visible: root.peers.length > 0
                    Text {
                        text: root.t("torrent.peers")
                        color: Theme.textPrimary
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.DemiBold
                    }
                    Repeater {
                        model: root.peers.slice(0, 8)
                        delegate: RowLayout {
                            required property var modelData
                            Layout.fillWidth: true
                            Text {
                                Layout.fillWidth: true
                                text: String(modelData.address || "") + " · " + String(modelData.direction || "")
                                color: Theme.textMuted
                                font.pixelSize: Theme.fontTiny
                                elide: Text.ElideMiddle
                            }
                            Text {
                                text: String(modelData.state || "—")
                                color: Theme.textSecondary
                                font.pixelSize: Theme.fontTiny
                            }
                        }
                    }
                }
            }
        }
    }

    Connections {
        target: root.api
        function onTorrentDetailsChanged() {
            if (String(root.api.torrentDetailsTaskId || "") !== root.taskId)
                return
            root.syncFromDetails()
        }
        function onTorrentDetailsFailed(taskId, message) {
            if (taskId === root.taskId)
                root.errorText = message
        }
        function onTorrentDetailsActionCompleted(action, taskId) {
            if (taskId !== root.taskId)
                return
            if (action === "files")
                root.applyingFiles = false
            if (action === "seeding")
                root.applyingSeeding = false
            if (action === "reauthorize") {
                root.reauthorizing = false
                root.trackerMagnetUri = ""
                root.revealTrackerMagnet = false
            }
            root.errorText = ""
            root.syncFromDetails()
        }
        function onTorrentDetailsActionFailed(taskId, message) {
            if (taskId !== root.taskId)
                return
            root.applyingFiles = false
            root.applyingSeeding = false
            root.reauthorizing = false
            root.errorText = message
        }
    }
}
