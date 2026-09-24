import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var api
    required property var settings
    required property var desktop

    property string errorText: ""
    property string statusText: ""
    property bool playlistMode: false
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function formatBytes(value) {
        const bytes = Number(value || 0)
        if (bytes <= 0) return root.t("common.unknown")
        if (bytes >= 1024 * 1024 * 1024)
            return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB"
        if (bytes >= 1024 * 1024)
            return (bytes / (1024 * 1024)).toFixed(1) + " MB"
        if (bytes >= 1024)
            return (bytes / 1024).toFixed(0) + " KB"
        return bytes + " B"
    }

    function rebuildQualityModel() {
        qualityModel.clear()
        qualityModel.append({ label: "Best available", value: "best", size: 0 })

        const seen = ({})
        for (let i = 0; i < api.mediaFormats.length; ++i) {
            const format = api.mediaFormats[i]
            const height = Number(format.height || 0)
            if (height <= 0 || seen[height]) continue
            seen[height] = true
            qualityModel.append({
                label: height + "p" + (format.ext ? " · " + format.ext.toUpperCase() : ""),
                value: height + "p",
                size: Number(format.filesize || 0)
            })
        }

        if (qualityBox.currentIndex < 0)
            qualityBox.currentIndex = 0
    }

    function analyze() {
        const url = urlField.text.trim()
        if (url.length === 0) {
            errorText = "Enter a media URL."
            return
        }

        errorText = ""
        statusText = ""
        if (playlistMode)
            api.probeMediaPlaylist(url)
        else
            api.probeMedia(url)
    }

    function startDownload() {
        const url = urlField.text.trim()
        if (url.length === 0) {
            errorText = "Enter a media URL."
            return
        }

        const isAudio = modeBox.currentIndex === 1
        const qualityValue = qualityBox.currentValue || "best"
        const options = {
            mode: isAudio ? "audio" : "video",
            quality: qualityValue,
            audioFormat: audioFormatBox.currentValue || "m4a",
            ffmpegEnabled: ffmpegCheck.checked,
            bitrate: bitrateBox.currentValue || "320K",
            outputTemplate: outputTemplate.text.trim().length > 0
                ? outputTemplate.text.trim()
                : "%(title)s.%(ext)s",
            playlist: playlistMode,
            playlistItems: playlistMode && playlistItems.text.trim().length > 0
                ? playlistItems.text.trim()
                : undefined,
            subtitles: subtitlesCheck.checked,
            subtitleLanguages: subtitleLanguages.text.trim().length > 0
                ? subtitleLanguages.text.trim()
                : undefined,
            embedSubtitles: subtitlesCheck.checked && embedSubtitlesCheck.checked,
            writeThumbnail: thumbnailCheck.checked,
            embedThumbnail: thumbnailCheck.checked && embedThumbnailCheck.checked,
            writeInfoJson: infoJsonCheck.checked,
            writeDescription: descriptionCheck.checked
        }

        let displayName = ""
        if (playlistMode)
            displayName = api.mediaPlaylistTitle
        else if (api.mediaProbe)
            displayName = api.mediaProbe.title || ""

        errorText = ""
        statusText = "Creating media task…"
        api.createMediaDownload(
            url,
            displayName,
            saveDirectory.text,
            options,
            startImmediately.checked
        )
    }

    Component.onCompleted: {
        api.refreshFfmpegStatus()
        rebuildQualityModel()
        saveDirectory.text = settings.defaultSaveDirectory
        startImmediately.checked = settings.startImmediately
    }

    Connections {
        target: api

        function onMediaProbeChanged() {
            if (!api.mediaProbeBusy)
                root.rebuildQualityModel()
        }

        function onMediaProbeFailed(message) {
            root.errorText = message
            root.statusText = ""
        }

        function onMediaPlaylistFailed(message) {
            root.errorText = message
            root.statusText = ""
        }

        function onMediaDownloadCreated(taskId) {
            root.statusText = "Media task created · " + taskId
            root.errorText = ""
        }

        function onRequestFailed(message) {
            if (root.visible) {
                root.errorText = message
                root.statusText = ""
            }
        }
    }

    ListModel {
        id: qualityModel
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
                    text: root.t("media.title")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontTitle
                    font.weight: Font.DemiBold
                }

                Text {
                    text: root.t("media.subtitle")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontSmall
                }
            }

            Item { Layout.fillWidth: true }

            Rectangle {
                implicitWidth: ffmpegLabel.implicitWidth + 20
                implicitHeight: 26
                radius: 13
                color: api.ffmpegAvailable ? Qt.rgba(0.25, 0.73, 0.31, 0.12) : Theme.surface
                border.color: api.ffmpegAvailable ? Theme.success : Theme.border

                Text {
                    id: ffmpegLabel
                    anchors.centerIn: parent
                    text: api.ffmpegAvailable ? "FFmpeg ready" : "FFmpeg unavailable"
                    color: api.ffmpegAvailable ? Theme.success : Theme.textMuted
                    font.pixelSize: Theme.fontTiny
                    font.weight: Font.DemiBold
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 54
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            RowLayout {
                anchors.fill: parent
                anchors.margins: 9
                spacing: 8

                TextField {
                    id: urlField
                    Layout.fillWidth: true
                    placeholderText: "https://…"
                    selectByMouse: true
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                    Accessible.name: root.t("add.url")
                    onAccepted: root.analyze()
                }

                CheckBox {
                    id: playlistCheck
                    text: root.t("media.playlist")
                    checked: root.playlistMode
                    onToggled: {
                        root.playlistMode = checked
                        root.errorText = ""
                        root.statusText = ""
                    }
                }

                Button {
                    text: api.mediaProbeBusy || api.mediaPlaylistBusy ? root.t("media.analyzing") : root.t("media.analyze")
                    enabled: api.connected
                        && !api.mediaProbeBusy
                        && !api.mediaPlaylistBusy
                        && urlField.text.trim().length > 0
                    onClicked: root.analyze()
                }
            }
        }

        SplitView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            orientation: Qt.Horizontal

            Rectangle {
                SplitView.preferredWidth: 520
                SplitView.minimumWidth: 390
                color: Theme.surface
                radius: Theme.radiusMedium
                border.color: Theme.border

                ScrollView {
                    anchors.fill: parent
                    anchors.margins: 12
                    clip: true

                    ColumnLayout {
                        width: parent.availableWidth
                        spacing: 12

                        Text {
                            text: "Download options"
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontBody
                            font.weight: Font.DemiBold
                        }

                        GridLayout {
                            Layout.fillWidth: true
                            columns: 2
                            columnSpacing: 10
                            rowSpacing: 10

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4

                                Text { text: "Mode"; color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: modeBox
                                    Layout.fillWidth: true
                                    model: ["Video + audio", "Audio only"]
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4

                                Text { text: "Quality"; color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: qualityBox
                                    Layout.fillWidth: true
                                    enabled: modeBox.currentIndex === 0
                                    model: qualityModel
                                    textRole: "label"
                                    valueRole: "value"
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                visible: modeBox.currentIndex === 1

                                Text { text: "Audio format"; color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: audioFormatBox
                                    Layout.fillWidth: true
                                    model: [
                                        { label: "M4A", value: "m4a" },
                                        { label: "MP3", value: "mp3" },
                                        { label: "Opus", value: "opus" },
                                        { label: "FLAC", value: "flac" },
                                        { label: "WAV", value: "wav" }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                visible: modeBox.currentIndex === 1

                                Text { text: "Audio quality"; color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: bitrateBox
                                    Layout.fillWidth: true
                                    model: [
                                        { label: "Best", value: "0" },
                                        { label: "320K", value: "320K" },
                                        { label: "256K", value: "256K" },
                                        { label: "192K", value: "192K" },
                                        { label: "128K", value: "128K" }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                }
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 4

                            Text { text: "Destination folder"; color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 6

                                TextField {
                                    id: saveDirectory
                                    Layout.fillWidth: true
                                    placeholderText: root.t("media.destination")
                                    selectByMouse: true
                                    LayoutMirroring.enabled: false
                                    horizontalAlignment: Text.AlignLeft
                                    Accessible.name: root.t("common.destination")
                                }

                                Button {
                                    text: root.t("common.browse")
                                    onClicked: {
                                        const chosen = desktop.chooseDirectory(saveDirectory.text)
                                        if (chosen.length > 0)
                                            saveDirectory.text = chosen
                                    }
                                }
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 4

                            Text { text: "Output template"; color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                            TextField {
                                id: outputTemplate
                                Layout.fillWidth: true
                                text: "%(title)s.%(ext)s"
                                selectByMouse: true
                                font.family: "monospace"
                                LayoutMirroring.enabled: false
                                horizontalAlignment: Text.AlignLeft
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 4
                            visible: root.playlistMode

                            Text { text: "Playlist items"; color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                            TextField {
                                id: playlistItems
                                Layout.fillWidth: true
                                placeholderText: "Optional: 1-10,15,20"
                                selectByMouse: true
                                LayoutMirroring.enabled: false
                                horizontalAlignment: Text.AlignLeft
                            }
                        }

                        Flow {
                            Layout.fillWidth: true
                            spacing: 8

                            CheckBox {
                                id: ffmpegCheck
                                text: "Use FFmpeg"
                                checked: true
                            }

                            CheckBox {
                                id: subtitlesCheck
                                text: "Subtitles"
                            }

                            CheckBox {
                                id: embedSubtitlesCheck
                                text: "Embed subtitles"
                                enabled: subtitlesCheck.checked && ffmpegCheck.checked
                            }

                            CheckBox {
                                id: thumbnailCheck
                                text: "Thumbnail"
                            }

                            CheckBox {
                                id: embedThumbnailCheck
                                text: "Embed thumbnail"
                                enabled: thumbnailCheck.checked && ffmpegCheck.checked
                            }

                            CheckBox {
                                id: infoJsonCheck
                                text: "Info JSON"
                            }

                            CheckBox {
                                id: descriptionCheck
                                text: "Description"
                            }
                        }

                        TextField {
                            id: subtitleLanguages
                            Layout.fillWidth: true
                            visible: subtitlesCheck.checked
                            placeholderText: "Subtitle languages, e.g. en,ar"
                            selectByMouse: true
                            LayoutMirroring.enabled: false
                            horizontalAlignment: Text.AlignLeft
                        }

                        Rectangle {
                            Layout.fillWidth: true
                            Layout.preferredHeight: 1
                            color: Theme.border
                        }

                        CheckBox {
                            id: startImmediately
                            text: root.t("common.startImmediately")
                            checked: true
                        }
                    }
                }
            }

            Rectangle {
                SplitView.fillWidth: true
                SplitView.minimumWidth: 360
                color: Theme.surface
                radius: Theme.radiusMedium
                border.color: Theme.border

                Item {
                    anchors.fill: parent
                    anchors.margins: 12

                    ColumnLayout {
                        anchors.fill: parent
                        spacing: 10

                        Text {
                            text: root.playlistMode ? "Playlist preview" : "Media preview"
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontBody
                            font.weight: Font.DemiBold
                        }

                        Rectangle {
                            Layout.fillWidth: true
                            Layout.preferredHeight: root.playlistMode ? 74 : 128
                            radius: Theme.radiusMedium
                            color: Theme.surfaceRaised
                            border.color: Theme.border

                            RowLayout {
                                anchors.fill: parent
                                anchors.margins: 10
                                spacing: 10

                                Image {
                                    visible: !root.playlistMode
                                        && api.mediaProbe.thumbnail
                                        && String(api.mediaProbe.thumbnail).length > 0
                                    Layout.preferredWidth: visible ? 150 : 0
                                    Layout.fillHeight: true
                                    source: visible ? api.mediaProbe.thumbnail : ""
                                    fillMode: Image.PreserveAspectCrop
                                    asynchronous: true
                                    cache: true
                                }

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 3

                                    Text {
                                        Layout.fillWidth: true
                                        text: root.playlistMode
                                            ? (api.mediaPlaylistTitle || "Analyze a playlist to inspect entries")
                                            : (api.mediaProbe.title || "Analyze a media URL to inspect formats")
                                        color: Theme.textPrimary
                                        font.pixelSize: Theme.fontBody
                                        font.weight: Font.DemiBold
                                        wrapMode: Text.WordWrap
                                        maximumLineCount: 2
                                        elide: Text.ElideRight
                                    }

                                    Text {
                                        visible: !root.playlistMode
                                        text: api.mediaProbe.durationString
                                            ? api.mediaProbe.durationString + " · "
                                                + api.mediaFormats.length + " video qualities"
                                            : api.mediaFormats.length + " video qualities"
                                        color: Theme.textMuted
                                        font.pixelSize: Theme.fontTiny
                                    }

                                    Text {
                                        visible: root.playlistMode
                                        text: api.mediaPlaylistEntries.length + " item(s)"
                                        color: Theme.textMuted
                                        font.pixelSize: Theme.fontTiny
                                    }
                                }
                            }
                        }

                        ListView {
                            id: previewList
                            Layout.fillWidth: true
                            Layout.fillHeight: true
                            clip: true
                            spacing: 4
                            model: root.playlistMode ? api.mediaPlaylistEntries : api.mediaFormats
                            ScrollBar.vertical: ScrollBar {}

                            delegate: Rectangle {
                                required property var modelData
                                width: previewList.width
                                height: 50
                                radius: Theme.radiusSmall
                                color: Theme.surfaceRaised
                                border.color: Theme.border

                                RowLayout {
                                    anchors.fill: parent
                                    anchors.leftMargin: 10
                                    anchors.rightMargin: 10
                                    spacing: 10

                                    ColumnLayout {
                                        Layout.fillWidth: true
                                        spacing: 1

                                        Text {
                                            Layout.fillWidth: true
                                            text: root.playlistMode
                                                ? (modelData.title || modelData.id || "Playlist item")
                                                : (modelData.height + "p · "
                                                    + String(modelData.ext || "").toUpperCase())
                                            color: Theme.textPrimary
                                            font.pixelSize: Theme.fontSmall
                                            font.weight: Font.Medium
                                            elide: Text.ElideRight
                                        }

                                        Text {
                                            Layout.fillWidth: true
                                            text: root.playlistMode
                                                ? (modelData.durationString || modelData.url || "")
                                                : ((modelData.vcodec || "") + " · "
                                                    + root.formatBytes(modelData.filesize))
                                            color: Theme.textMuted
                                            font.pixelSize: Theme.fontTiny
                                            elide: Text.ElideRight
                                        }
                                    }

                                    Text {
                                        visible: root.playlistMode && modelData.index
                                        text: "#" + modelData.index
                                        color: Theme.textSecondary
                                        font.pixelSize: Theme.fontTiny
                                        font.family: "monospace"
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Text {
            Layout.fillWidth: true
            visible: root.errorText.length > 0
            text: root.errorText
            color: Theme.danger
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.WordWrap
        }

        Text {
            Layout.fillWidth: true
            visible: root.statusText.length > 0
            text: root.statusText
            color: Theme.success
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.WordWrap
        }

        RowLayout {
            Layout.fillWidth: true

            Text {
                text: api.mediaProbeBusy || api.mediaPlaylistBusy
                    ? "The daemon is analyzing the source…"
                    : "Analysis and download execution remain inside the Rust daemon."
                color: Theme.textMuted
                font.pixelSize: Theme.fontTiny
            }

            Item { Layout.fillWidth: true }

            Button {
                text: root.t("media.start")
                enabled: api.connected
                    && !api.mediaProbeBusy
                    && !api.mediaPlaylistBusy
                    && urlField.text.trim().length > 0
                onClicked: root.startDownload()

                background: Rectangle {
                    radius: Theme.radiusMedium
                    color: parent.enabled ? Theme.accent : Theme.accentMuted
                }

                contentItem: Text {
                    text: parent.text
                    color: parent.enabled ? "white" : Theme.textMuted
                    font.pixelSize: Math.round(11 * Theme.fontScale)
                    font.weight: Font.DemiBold
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }
            }
        }
    }
}
