import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    property var item: ({})
    property var speedHistory: []
    property string languageToken: i18n.language
    signal closeRequested()
    signal openFileRequested()
    signal openFolderRequested()
    signal propertiesRequested()

    readonly property bool hasItem: item && item.taskId !== undefined && item.taskId !== ""
    readonly property bool completed: (item.status || "").toLowerCase() === "completed"
    readonly property bool hasSavePath: (item.savePath || "").length > 0

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

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

    function formatSpeed(value) {
        if (!value || value <= 0) return "—"
        if (value >= 1024 * 1024)
            return (value / (1024 * 1024)).toFixed(1) + " MB/s"
        if (value >= 1024)
            return (value / 1024).toFixed(0) + " KB/s"
        return value + " B/s"
    }

    function formatEta(value) {
        if (!value || value <= 0) return "—"
        if (value < 60) return value + "s"
        if (value < 3600) return Math.floor(value / 60) + "m " + (value % 60) + "s"
        return Math.floor(value / 3600) + "h " + Math.floor((value % 3600) / 60) + "m"
    }

    function fileGlyph() {
        const type = String(root.item.fileType || root.item.category || "").toLowerCase()
        const name = String(root.item.name || "").toLowerCase()
        if (type.indexOf("video") >= 0 || /\.(mp4|mkv|webm|avi|mov)$/.test(name))
            return "▶"
        if (type.indexOf("audio") >= 0 || /\.(mp3|flac|wav|m4a|ogg)$/.test(name))
            return "♪"
        if (type.indexOf("image") >= 0 || /\.(png|jpe?g|webp|gif|bmp)$/.test(name))
            return "▧"
        if (/\.pdf$/.test(name))
            return "PDF"
        if (/\.(zip|rar|7z|tar|gz)$/.test(name))
            return "ZIP"
        return "◆"
    }

    function statusColor() {
        const status = String(root.item.status || "").toLowerCase()
        if (status === "completed") return Theme.success
        if (status === "failed" || status === "error") return Theme.danger
        if (status === "paused") return Theme.warning
        return Theme.accent
    }

    onItemChanged: {
        root.speedHistory = []
        speedCanvas.requestPaint()
    }

    Timer {
        interval: 1000
        repeat: true
        running: root.hasItem
        onTriggered: {
            const next = root.speedHistory.slice()
            next.push(Math.max(0, Number(root.item.speedBytesPerSec || 0)))
            while (next.length > 28)
                next.shift()
            root.speedHistory = next
            speedCanvas.requestPaint()
        }
    }

    color: Theme.surface
    border.color: Theme.border
    radius: Theme.radiusLarge
    clip: true

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 202
            color: Theme.surfaceRaised

            gradient: Gradient {
                GradientStop { position: 0.0; color: Theme.accentMuted }
                GradientStop { position: 1.0; color: Theme.surfaceRaised }
            }

            Rectangle {
                anchors.centerIn: parent
                width: 74
                height: 74
                radius: Theme.radiusLarge
                color: Qt.rgba(Theme.accent.r, Theme.accent.g, Theme.accent.b, 0.18)
                border.color: Theme.accent

                Text {
                    anchors.centerIn: parent
                    text: root.fileGlyph()
                    color: Theme.accent
                    font.pixelSize: text.length > 1
                        ? Theme.fontMedium : Math.round(30 * Theme.fontScale)
                    font.weight: Font.Bold
                }
            }

            Rectangle {
                anchors.left: parent.left
                anchors.top: parent.top
                anchors.margins: 12
                implicitWidth: previewStatus.implicitWidth + 18
                implicitHeight: 26
                radius: 13
                color: Qt.rgba(root.statusColor().r, root.statusColor().g, root.statusColor().b, 0.16)

                Text {
                    id: previewStatus
                    anchors.centerIn: parent
                    text: root.item.status || root.t("common.unknown")
                    color: root.statusColor()
                    font.pixelSize: Theme.fontSmall
                    font.weight: Font.DemiBold
                }
            }

            ToolButton {
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 8
                text: "×"
                Accessible.name: root.t("common.close")
                onClicked: root.closeRequested()
            }
        }

        Text {
            Layout.fillWidth: true
            Layout.leftMargin: 14
            Layout.rightMargin: 14
            Layout.topMargin: 12
            Layout.bottomMargin: 8
            text: root.item.name || root.t("common.unnamedDownload")
            color: Theme.textPrimary
            font.pixelSize: Theme.fontMedium
            font.weight: Font.DemiBold
            elide: Text.ElideMiddle
        }

        TabBar {
            id: tabs
            Layout.fillWidth: true

            TabButton { text: root.t("settings.general") }
            TabButton { text: root.t("details.title") }
            TabButton { text: root.t("nav.media") }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 1
            color: Theme.border
        }

        StackLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            currentIndex: tabs.currentIndex

            ScrollView {
                clip: true

                ColumnLayout {
                    width: parent.availableWidth
                    spacing: 12
                    leftPadding: 14
                    rightPadding: 14
                    topPadding: 14
                    bottomPadding: 14

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 6

                        ProgressBar {
                            Layout.fillWidth: true
                            from: 0
                            to: 1
                            value: root.item.progress || 0
                        }

                        RowLayout {
                            Layout.fillWidth: true

                            Text {
                                text: root.formatBytes(root.item.downloadedBytes)
                                    + " / " + root.formatBytes(root.item.sizeBytes)
                                color: Theme.textSecondary
                                font.pixelSize: Theme.fontSmall
                                font.family: "monospace"
                            }

                            Item { Layout.fillWidth: true }

                            Text {
                                text: Math.round((root.item.progress || 0) * 100) + "%"
                                color: Theme.textPrimary
                                font.pixelSize: Theme.fontSmall
                                font.family: "monospace"
                            }
                        }
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        Layout.preferredHeight: metricsGrid.implicitHeight + 22
                        radius: Theme.radiusMedium
                        color: Theme.surfaceRaised
                        border.color: Theme.border

                        GridLayout {
                            id: metricsGrid
                            anchors.fill: parent
                            anchors.margins: 11
                            columns: 2
                            columnSpacing: 12
                            rowSpacing: 9

                            Text { text: root.t("common.size"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.formatBytes(root.item.sizeBytes); color: Theme.textPrimary; font.pixelSize: Theme.fontSmall; font.family: "monospace" }
                            Text { text: root.t("common.status"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.item.status || root.t("common.unknown"); color: root.statusColor(); font.pixelSize: Theme.fontSmall; font.weight: Font.DemiBold }
                            Text { text: root.t("common.speed"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.formatSpeed(root.item.speedBytesPerSec); color: Theme.textPrimary; font.pixelSize: Theme.fontSmall; font.family: "monospace" }
                            Text { text: root.t("common.eta"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.formatEta(root.item.etaSeconds); color: Theme.textPrimary; font.pixelSize: Theme.fontSmall; font.family: "monospace" }
                            Text { text: root.t("common.connections"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.item.connections || "—"; color: Theme.textPrimary; font.pixelSize: Theme.fontSmall; font.family: "monospace" }
                            Text { text: root.t("downloads.dateAdded"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.item.dateAdded || "—"; color: Theme.textPrimary; font.pixelSize: Theme.fontSmall; font.family: "monospace"; elide: Text.ElideRight }
                        }
                    }

                    Text {
                        text: root.t("common.speed")
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.DemiBold
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        Layout.preferredHeight: 116
                        radius: Theme.radiusMedium
                        color: Theme.surfaceRaised
                        border.color: Theme.border

                        Canvas {
                            id: speedCanvas
                            anchors.fill: parent
                            anchors.margins: 8

                            onPaint: {
                                const ctx = getContext("2d")
                                ctx.clearRect(0, 0, width, height)

                                ctx.strokeStyle = Theme.border.toString()
                                ctx.lineWidth = 1
                                for (let row = 1; row < 4; ++row) {
                                    const y = height * row / 4
                                    ctx.beginPath()
                                    ctx.moveTo(0, y)
                                    ctx.lineTo(width, y)
                                    ctx.stroke()
                                }

                                if (root.speedHistory.length < 2)
                                    return

                                let maxValue = 1
                                for (let i = 0; i < root.speedHistory.length; ++i)
                                    maxValue = Math.max(maxValue, root.speedHistory[i])

                                ctx.strokeStyle = Theme.accent.toString()
                                ctx.lineWidth = 2
                                ctx.beginPath()
                                for (let i = 0; i < root.speedHistory.length; ++i) {
                                    const x = width * i / Math.max(1, root.speedHistory.length - 1)
                                    const y = height - (root.speedHistory[i] / maxValue) * (height - 8) - 4
                                    if (i === 0)
                                        ctx.moveTo(x, y)
                                    else
                                        ctx.lineTo(x, y)
                                }
                                ctx.stroke()
                            }

                            Connections {
                                target: Theme
                                function onAccentBaseChanged() { speedCanvas.requestPaint() }
                                function onDarkModeChanged() { speedCanvas.requestPaint() }
                            }
                        }
                    }
                }
            }

            ScrollView {
                clip: true

                ColumnLayout {
                    width: parent.availableWidth
                    spacing: 12
                    leftPadding: 14
                    rightPadding: 14
                    topPadding: 14
                    bottomPadding: 14

                    Text {
                        text: root.t("common.sourceUrl")
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                        font.weight: Font.DemiBold
                    }

                    Text {
                        Layout.fillWidth: true
                        text: root.item.url || "—"
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontSmall
                        wrapMode: Text.WrapAnywhere
                    }

                    Text {
                        Layout.topMargin: 4
                        text: root.t("common.savePath")
                        color: Theme.textMuted
                        font.pixelSize: Theme.fontTiny
                        font.weight: Font.DemiBold
                    }

                    Text {
                        Layout.fillWidth: true
                        text: root.item.savePath || "—"
                        LayoutMirroring.enabled: false
                        horizontalAlignment: Text.AlignLeft
                        color: Theme.textSecondary
                        font.pixelSize: Theme.fontSmall
                        wrapMode: Text.WrapAnywhere
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        Layout.preferredHeight: detailsGrid.implicitHeight + 22
                        radius: Theme.radiusMedium
                        color: Theme.surfaceRaised
                        border.color: Theme.border

                        GridLayout {
                            id: detailsGrid
                            anchors.fill: parent
                            anchors.margins: 11
                            columns: 2
                            rowSpacing: 9

                            Text { text: root.t("common.taskId"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.item.taskId || "—"; color: Theme.textPrimary; font.pixelSize: Theme.fontSmall; font.family: "monospace"; elide: Text.ElideMiddle }
                            Text { text: root.t("common.engine"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.item.engine || "—"; color: Theme.textPrimary; font.pixelSize: Theme.fontSmall }
                            Text { text: root.t("common.resumable"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.item.resumable ? root.t("common.yes") : root.t("common.no"); color: Theme.textPrimary; font.pixelSize: Theme.fontSmall }
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 6

                        Button {
                            Layout.fillWidth: true
                            text: root.t("details.openFile")
                            Accessible.name: text
                            enabled: root.completed && root.hasSavePath
                            onClicked: root.openFileRequested()
                        }

                        Button {
                            Layout.fillWidth: true
                            text: root.t("details.showFolder")
                            Accessible.name: text
                            enabled: root.hasSavePath
                            onClicked: root.openFolderRequested()
                        }
                    }

                    Button {
                        Layout.fillWidth: true
                        text: root.t("action.properties")
                        Accessible.name: text
                        enabled: root.hasItem
                        onClicked: root.propertiesRequested()
                    }
                }
            }

            ScrollView {
                clip: true

                ColumnLayout {
                    width: parent.availableWidth
                    spacing: 12
                    leftPadding: 14
                    rightPadding: 14
                    topPadding: 14
                    bottomPadding: 14

                    Rectangle {
                        Layout.fillWidth: true
                        Layout.preferredHeight: mediaGrid.implicitHeight + 24
                        radius: Theme.radiusMedium
                        color: Theme.surfaceRaised
                        border.color: Theme.border

                        GridLayout {
                            id: mediaGrid
                            anchors.fill: parent
                            anchors.margins: 12
                            columns: 2
                            rowSpacing: 10

                            Text { text: root.t("downloads.smartCategory"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.item.fileType || root.item.category || "—"; color: Theme.textPrimary; font.pixelSize: Theme.fontSmall }
                            Text { text: root.t("common.engine"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.item.engine || "—"; color: Theme.textPrimary; font.pixelSize: Theme.fontSmall }
                            Text { text: root.t("common.resumable"); color: Theme.textMuted; font.pixelSize: Theme.fontSmall }
                            Text { text: root.item.resumable ? root.t("common.yes") : root.t("common.no"); color: Theme.textPrimary; font.pixelSize: Theme.fontSmall }
                        }
                    }
                }
            }
        }
    }
}
