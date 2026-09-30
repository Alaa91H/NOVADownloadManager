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
    property var capabilitySnapshot: api.engineCapabilities
    property bool selectAllPlaylist: true
    property bool defaultsApplied: false
    property var selectedPlaylistIndexes: ({})
    property string languageToken: i18n.language

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function capabilitySupported(id) {
        const snapshot = root.capabilitySnapshot || ({})
        if (!snapshot.capabilityRegistry)
            return false
        return api.runtimeCapabilitySupported(id)
    }

    function transcodeCapabilitySupported(track) {
        if (track === "video")
            return root.capabilitySupported("media.videoTranscode")
        return root.capabilitySupported("media.audioTranscode")
    }

    function urlLooksLikePlaylist(value) {
        return /[?&]list=[^&]+/.test(String(value || ""))
    }

    function resetPlaylistSelection() {
        selectAllPlaylist = true
        selectedPlaylistIndexes = ({})
    }

    function playlistSelectionCount() {
        if (selectAllPlaylist)
            return api.mediaPlaylistEntries.length
        let count = 0
        for (const key in selectedPlaylistIndexes) {
            if (selectedPlaylistIndexes[key])
                ++count
        }
        return count
    }

    function playlistItemsValue() {
        if (selectAllPlaylist)
            return ""
        const values = []
        for (const key in selectedPlaylistIndexes) {
            if (selectedPlaylistIndexes[key])
                values.push(Number(key))
        }
        values.sort(function(a, b) { return a - b })
        return values.join(",")
    }

    function togglePlaylistItem(index) {
        if (selectAllPlaylist)
            return
        const next = Object.assign({}, selectedPlaylistIndexes)
        const key = String(index)
        next[key] = !next[key]
        selectedPlaylistIndexes = next
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

    function outputContainerOptions(track) {
        const options = [{ label: root.t("media.sourceFormat"), value: "auto" }]
        if (!root.capabilitySupported("media.nativeMux") || !root.transcodeCapabilitySupported(track))
            return options
        const engines = api.engineCapabilities.engines || ({})
        const media = engines.media || ({})
        const capabilities = media.capabilities || ({})
        const codecRegistry = capabilities.nativeCodecRegistry || ({})
        const codec = codecRegistry[track] || ({})
        const values = codec.outputContainers
        if (Array.isArray(values)) {
            for (let i = 0; i < values.length; ++i) {
                const value = String(values[i] || "").trim()
                if (value.length > 0)
                    options.push({ label: value.toUpperCase(), value: value })
            }
        }
        return options
    }

    function encoderOptions(track, container) {
        const options = [{ label: root.t("media.streamCopy"), value: "copy" }]
        if (String(container || "auto") === "auto")
            return options
        if (!root.capabilitySupported("media.nativeMux") || !root.transcodeCapabilitySupported(track))
            return options
        const engines = api.engineCapabilities.engines || ({})
        const media = engines.media || ({})
        const capabilities = media.capabilities || ({})
        const codecRegistry = capabilities.nativeCodecRegistry || ({})
        const codec = codecRegistry[track] || ({})
        const encoders = codec.encoders
        if (!Array.isArray(encoders))
            return options
        const byContainer = codec.encodersByContainer || ({})
        const allowed = byContainer[String(container)] || []
        for (let i = 0; i < encoders.length; ++i) {
            const encoder = String(encoders[i] || "").trim()
            if (encoder.length > 0 && allowed.indexOf(encoder) >= 0)
                options.push({ label: encoder, value: encoder })
        }
        return options
    }

    function supportsCrf(encoder) {
        return ["h264", "vp9"]
            .indexOf(String(encoder || "")) >= 0
    }

    function supportsAudioBitrate(encoder) {
        return ["aac", "mp3", "opus", "vorbis"]
            .indexOf(String(encoder || "")) >= 0
    }

    function localCodecAvailable() {
        if (!root.capabilitySupported("media.nativeCodecs"))
            return false
        const engines = api.engineCapabilities.engines || ({})
        const media = engines.media || ({})
        const capabilities = media.capabilities || ({})
        const codecs = capabilities.nativeCodecRegistry || ({})
        const audio = codecs.audio || ({})
        const video = codecs.video || ({})
        return (Array.isArray(audio.encoders) && audio.encoders.length > 0)
            || (Array.isArray(video.encoders) && video.encoders.length > 0)
    }

    function localSubtitleContainerAvailable(container) {
        if (!root.capabilitySupported("media.subtitleEmbedding"))
            return false
        const engines = api.engineCapabilities.engines || ({})
        const media = engines.media || ({})
        const capabilities = media.capabilities || ({})
        const codecs = capabilities.nativeCodecRegistry || ({})
        const containers = codecs.subtitleContainers || []
        return Array.isArray(containers) && containers.indexOf(String(container || "")) >= 0
    }

    function selectEncoder(choices, preferred) {
        if (!Array.isArray(choices))
            return 0
        for (let i = 0; i < choices.length; ++i) {
            if (String(choices[i].value || "") === preferred)
                return i
        }
        return preferred === "copy" || choices.length < 2 ? 0 : 1
    }

    function preferredVideoEncoder(container) {
        if (String(container || "auto") === "auto")
            return "copy"
        return "h264"
    }

    function preferredAudioEncoder(container) {
        switch (String(container || "auto")) {
        case "m4a": return "aac"
        case "aac": return "aac"
        case "mp3": return "mp3"
        case "opus": return "opus"
        case "ogg": return "vorbis"
        case "flac": return "flac"
        case "wav": return "pcm_s16le"
        case "auto": return "copy"
        default: return "aac"
        }
    }

    function rebuildQualityModel() {
        qualityModel.clear()
        qualityModel.append({ label: root.t("media.bestAvailable"), value: "best", size: 0 })

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

        if (qualityModel.count === 1) {
            const fallbackHeights = [4320, 2880, 2160, 1440, 1080, 720, 480, 360, 240, 144]
            for (let j = 0; j < fallbackHeights.length; ++j) {
                const height = fallbackHeights[j]
                qualityModel.append({
                    label: height + "p",
                    value: height + "p",
                    size: 0
                })
            }
        }

        if (qualityBox.currentIndex < 0)
            qualityBox.currentIndex = 0
    }

    function applyNativeDefaults() {
        if (defaultsApplied)
            return

        const a = settings.advancedSettings || ({})
        const quality = String(a.videoQuality || "best")
        const wanted = quality === "good" ? "720p" : quality === "worst" ? "480p" : "best"
        for (let i = 0; i < qualityModel.count; ++i) {
            if (String(qualityModel.get(i).value) === wanted) {
                qualityBox.currentIndex = i
                break
            }
        }

        subtitlesCheck.checked = Boolean(a.downloadSubtitles)
        subtitleLanguages.text = String(a.subtitleLanguage || "")
        defaultsApplied = true
    }

    function analyze() {
        const url = urlField.text.trim()
        if (url.length === 0) {
            errorText = root.t("media.enterUrl")
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
            errorText = root.t("media.enterUrl")
            return
        }

        const isAudio = modeBox.currentIndex === 1
        const qualityValue = qualityBox.currentValue || "best"

        if (playlistMode && !selectAllPlaylist && playlistSelectionCount() === 0) {
            errorText = root.t("media.noPlaylistSelection")
            return
        }
        if (!root.capabilitySupported("media.extraction")) {
            errorText = root.t("media.engineUnavailable")
            return
        }
        if (isAudio && (audioFormatBox.count === 0 || audioCodecBox.count === 0)) {
            errorText = root.t("media.audioConversionUnavailable")
            return
        }

        const options = {
            mode: isAudio ? "audio" : "video",
            quality: qualityValue,
            outputTemplate: outputTemplate.text.trim().length > 0
                ? outputTemplate.text.trim()
                : "%(title)s.%(ext)s",
            playlist: playlistMode,
            playlistItems: playlistMode && !selectAllPlaylist
                ? playlistItemsValue()
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
        if (isAudio) {
            options.audioFormat = audioFormatBox.currentValue || "m4a"
            options.bitrate = audioCodecBox.currentValue === "copy"
                || !root.supportsAudioBitrate(audioCodecBox.currentValue)
                || Number(bitrateBox.currentValue || 0) === 0
                ? "0"
                : String(Number(bitrateBox.currentValue) / 1000) + "K"
        } else if (videoContainerBox.currentValue && videoContainerBox.currentValue !== "auto") {
            options.remuxFormat = String(videoContainerBox.currentValue)
        }
        if (!isAudio && videoCodecBox.currentValue !== "copy")
            options.videoCodec = String(videoCodecBox.currentValue || "")
        if (audioCodecBox.currentValue)
            options.audioCodec = String(audioCodecBox.currentValue)
        if (!isAudio && videoCodecBox.currentValue !== "copy") {
            const videoBitrate = Number(videoBitrateBox.currentValue || 0)
            const crf = Number(videoCrfBox.currentValue || 0)
            const height = Number(outputHeightBox.currentValue || 0)
            const frameRate = Number(frameRateBox.currentValue || 0)
            if (videoBitrate > 0)
                options.videoBitrateBps = videoBitrate
            if (crf > 0 && root.supportsCrf(videoCodecBox.currentValue))
                options.transcodeCrf = crf
            if (height > 0)
                options.height = height
            if (frameRate > 0)
                options.frameRateMilli = frameRate
            if (String(videoCodecBox.currentValue) === "h264")
                options.transcodePreset = String(presetBox.currentValue || "medium")
        }
        const audioBitrate = Number(bitrateBox.currentValue || 0)
        if (!isAudio && audioBitrate > 0 && root.supportsAudioBitrate(audioCodecBox.currentValue))
            options.audioBitrateBps = audioBitrate
        const sampleRate = Number(audioSampleRateBox.currentValue || 0)
        const audioChannels = Number(audioChannelsBox.currentValue || 0)
        if (audioCodecBox.currentValue !== "copy") {
            if (sampleRate > 0)
                options.audioSampleRateHz = sampleRate
            if (audioChannels > 0)
                options.audioChannels = audioChannels
        }

        const defaults = settings.advancedSettings || ({})
        let defaultProxy = ""
        if (Boolean(defaults.vpnEnabled) && String(defaults.vpnMode || "") === "proxy")
            defaultProxy = String(defaults.vpnProxyUrl || "").trim()
        else if (Boolean(defaults.proxyEnabled) && String(defaults.proxyHost || "").trim().length > 0) {
            defaultProxy = String(defaults.proxyType || "http") + "://"
                + String(defaults.proxyHost).trim()
            if (String(defaults.proxyPort || "").trim().length > 0)
                defaultProxy += ":" + String(defaults.proxyPort).trim()
        }
        if (defaultProxy.length > 0)
            options.proxy = defaultProxy
        if (String(defaults.userAgent || "").trim().length > 0)
            options.userAgent = String(defaults.userAgent).trim()
        if (Boolean(defaults.vpnEnabled)
            && String(defaults.vpnMode || "") === "bind"
            && String(defaults.vpnBindAddress || "").trim().length > 0)
            options.sourceAddress = String(defaults.vpnBindAddress).trim()
        options.retries = Number(defaults.retryCount || 0)
        options.socketTimeoutSec = Number(defaults.timeoutSec || 60)
        options.bufferSizeKbs = Number(defaults.bufferSizeKb || 256)

        const advancedOptions = mediaAdvanced.buildOptions()
        for (const key in advancedOptions)
            options[key] = advancedOptions[key]

        let displayName = ""
        if (playlistMode)
            displayName = api.mediaPlaylistTitle
        else if (api.mediaProbe)
            displayName = api.mediaProbe.title || ""

        errorText = ""
        statusText = root.t("media.creating")
        api.createMediaDownload(
            url,
            displayName,
            saveDirectory.text,
            options,
            startImmediately.checked
        )
    }

    Timer {
        id: autoProbeTimer
        interval: 800
        repeat: false
        onTriggered: {
            const value = urlField.text.trim()
            if (api.connected && value.startsWith("http"))
                root.analyze()
        }
    }

    Component.onCompleted: {
        api.refreshEngineCapabilities()
        rebuildQualityModel()
        saveDirectory.text = settings.defaultSaveDirectory
        startImmediately.checked = settings.startImmediately
        Qt.callLater(root.applyNativeDefaults)
    }

    Connections {
        target: api

        function onConnectionChanged() {
            if (api.connected) {
                api.refreshEngineCapabilities()
            }
        }

        function onMediaProbeChanged() {
            if (!api.mediaProbeBusy)
                root.rebuildQualityModel()
        }

        function onMediaProbeFailed(message) {
            root.errorText = message
            root.statusText = ""
        }

        function onMediaPlaylistChanged() {
            if (!api.mediaPlaylistBusy)
                root.resetPlaylistSelection()
        }

        function onMediaPlaylistFailed(message) {
            root.errorText = message
            root.statusText = ""
        }

        function onMediaDownloadCreated(taskId) {
            root.statusText = root.t("media.created") + " · " + taskId
            root.errorText = ""
        }

        function onMediaPlaylistDownloadsCreated(accepted, failed, failureMessage) {
            root.statusText = root.t("media.created") + " · " + accepted + " / " + (accepted + failed)
            root.errorText = failureMessage || ""
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
                implicitWidth: localCodecLabel.implicitWidth + 20
                implicitHeight: 26
                radius: 13
                color: root.localCodecAvailable() ? Qt.rgba(0.25, 0.73, 0.31, 0.12) : Theme.surface
                border.color: root.localCodecAvailable() ? Theme.success : Theme.border

                Text {
                    id: localCodecLabel
                    anchors.centerIn: parent
                    text: root.localCodecAvailable() ? root.t("media.localCodecsReady") : root.t("media.localCodecsUnavailable")
                    color: root.localCodecAvailable() ? Theme.success : Theme.textMuted
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
                    onTextChanged: {
                        const detected = root.urlLooksLikePlaylist(text)
                        if (detected !== root.playlistMode) {
                            root.playlistMode = detected
                            playlistCheck.checked = detected
                            root.resetPlaylistSelection()
                        }
                        autoProbeTimer.restart()
                    }
                }

                CheckBox {
                    id: playlistCheck
                    text: root.t("media.playlist")
                    checked: root.playlistMode
                    enabled: api.mediaOptionSupported("playlist")
                    onToggled: {
                        root.playlistMode = checked
                        root.resetPlaylistSelection()
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
                            text: root.t("media.downloadOptions")
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

                                Text { text: root.t("media.mode"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: modeBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.mode")
                                    enabled: root.capabilitySupported("media.extraction")
                                    model: [root.t("media.videoAudio"), root.t("media.audioOnly")]
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4

                                Text { text: root.t("media.quality"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: qualityBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.quality")
                                    enabled: modeBox.currentIndex === 0
                                        && api.mediaOptionSupported("quality")
                                    model: qualityModel
                                    textRole: "label"
                                    valueRole: "value"
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                visible: modeBox.currentIndex === 0

                                Text { text: root.t("media.outputContainer"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: videoContainerBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.outputContainer")
                                    enabled: api.mediaOptionSupported("remuxFormat")
                                    model: root.outputContainerOptions("video")
                                    textRole: "label"
                                    valueRole: "value"
                                    currentIndex: 0
                                    onCurrentIndexChanged: {
                                        videoCodecBox.currentIndex = root.selectEncoder(
                                            root.encoderOptions("video", currentValue),
                                            root.preferredVideoEncoder(currentValue)
                                        )
                                        audioCodecBox.currentIndex = root.selectEncoder(
                                            root.encoderOptions("audio", currentValue),
                                            root.preferredAudioEncoder(currentValue)
                                        )
                                    }
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                visible: modeBox.currentIndex === 1

                                Text { text: root.t("media.audioFormat"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: audioFormatBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.audioFormat")
                                    enabled: api.mediaOptionSupported("audioFormat")
                                    model: root.outputContainerOptions("audio")
                                    textRole: "label"
                                    valueRole: "value"
                                    onCurrentIndexChanged: {
                                        audioCodecBox.currentIndex = root.selectEncoder(
                                            root.encoderOptions("audio", currentValue),
                                            root.preferredAudioEncoder(currentValue)
                                        )
                                    }
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                visible: modeBox.currentIndex === 0

                                Text { text: root.t("media.videoCodec"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: videoCodecBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.videoCodec")
                                    enabled: api.mediaOptionSupported("videoCodec")
                                    model: root.encoderOptions("video", videoContainerBox.currentValue)
                                    textRole: "label"
                                    valueRole: "value"
                                    currentIndex: 0
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Text { text: root.t("media.audioCodec"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: audioCodecBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.audioCodec")
                                    enabled: modeBox.currentIndex === 1
                                        && String(audioFormatBox.currentValue || "auto") !== "auto"
                                        && api.mediaOptionSupported("audioCodec")
                                    model: root.encoderOptions(
                                        "audio",
                                        modeBox.currentIndex === 1
                                            ? audioFormatBox.currentValue
                                            : videoContainerBox.currentValue
                                    )
                                    textRole: "label"
                                    valueRole: "value"
                                    currentIndex: 0
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                visible: modeBox.currentIndex === 0

                                Text { text: root.t("media.videoBitrate"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: videoBitrateBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.videoBitrate")
                                    enabled: videoCodecBox.currentValue !== "copy"
                                        && api.mediaOptionSupported("videoBitrateBps")
                                    model: [
                                        { label: root.t("media.encoderDefault"), value: 0 },
                                        { label: "1 Mbps", value: 1000000 },
                                        { label: "2.5 Mbps", value: 2500000 },
                                        { label: "5 Mbps", value: 5000000 },
                                        { label: "8 Mbps", value: 8000000 },
                                        { label: "12 Mbps", value: 12000000 }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                    onCurrentIndexChanged: {
                                        if (Number(currentValue || 0) > 0 && videoCrfBox.currentIndex > 0)
                                            videoCrfBox.currentIndex = 0
                                    }
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                visible: modeBox.currentIndex === 0

                                Text { text: root.t("media.videoQuality"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: videoCrfBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.videoQuality")
                                    enabled: videoCodecBox.currentValue !== "copy"
                                        && root.supportsCrf(videoCodecBox.currentValue)
                                    model: [
                                        { label: root.t("media.encoderDefault"), value: 0 },
                                        { label: root.t("media.crfHigh"), value: 18 },
                                        { label: root.t("media.crfBalanced"), value: 23 },
                                        { label: root.t("media.crfSmaller"), value: 28 }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                    onCurrentIndexChanged: {
                                        if (Number(currentValue || 0) > 0 && videoBitrateBox.currentIndex > 0)
                                            videoBitrateBox.currentIndex = 0
                                    }
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                visible: modeBox.currentIndex === 0

                                Text { text: root.t("media.outputResolution"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: outputHeightBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.outputResolution")
                                    enabled: videoCodecBox.currentValue !== "copy"
                                        && api.mediaOptionSupported("height")
                                    model: [
                                        { label: root.t("media.sourceResolution"), value: 0 },
                                        { label: "480p", value: 480 },
                                        { label: "720p", value: 720 },
                                        { label: "1080p", value: 1080 },
                                        { label: "1440p", value: 1440 },
                                        { label: "2160p", value: 2160 }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                visible: modeBox.currentIndex === 0

                                Text { text: root.t("media.frameRate"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: frameRateBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.frameRate")
                                    enabled: videoCodecBox.currentValue !== "copy"
                                        && api.mediaOptionSupported("frameRateMilli")
                                    model: [
                                        { label: root.t("media.sourceFrameRate"), value: 0 },
                                        { label: "24 fps", value: 24000 },
                                        { label: "30 fps", value: 30000 },
                                        { label: "60 fps", value: 60000 }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                visible: modeBox.currentIndex === 0

                                Text { text: root.t("media.encoderPreset"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: presetBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.encoderPreset")
                                    enabled: String(videoCodecBox.currentValue) === "h264"
                                        && api.mediaOptionSupported("transcodePreset")
                                    model: ["ultrafast", "fast", "medium", "slow", "veryslow"]
                                    currentIndex: 2
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4

                                Text { text: root.t("media.audioBitrate"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: bitrateBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.audioBitrate")
                                    enabled: api.mediaOptionSupported("bitrate")
                                        && root.supportsAudioBitrate(audioCodecBox.currentValue)
                                    model: [
                                        { label: root.t("media.encoderDefault"), value: 0 },
                                        { label: "320K", value: 320000 },
                                        { label: "256K", value: 256000 },
                                        { label: "192K", value: 192000 },
                                        { label: "128K", value: 128000 }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4

                                Text { text: root.t("media.audioSampleRate"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: audioSampleRateBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.audioSampleRate")
                                    enabled: audioCodecBox.currentValue !== "copy"
                                        && api.mediaOptionSupported("audioSampleRateHz")
                                    model: [
                                        { label: root.t("media.encoderDefault"), value: 0 },
                                        { label: "44.1 kHz", value: 44100 },
                                        { label: "48 kHz", value: 48000 },
                                        { label: "96 kHz", value: 96000 }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4

                                Text { text: root.t("media.audioChannels"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                                ComboBox {
                                    id: audioChannelsBox
                                    Layout.fillWidth: true
                                    Accessible.name: root.t("media.audioChannels")
                                    enabled: audioCodecBox.currentValue !== "copy"
                                        && api.mediaOptionSupported("audioChannels")
                                    model: [
                                        { label: root.t("media.encoderDefault"), value: 0 },
                                        { label: root.t("media.mono"), value: 1 },
                                        { label: root.t("media.stereo"), value: 2 }
                                    ]
                                    textRole: "label"
                                    valueRole: "value"
                                }
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 4

                            Text { text: root.t("media.destinationFolder"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
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

                            Text { text: root.t("media.outputTemplate"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 6

                                Button {
                                    text: root.t("media.templateTitle")
                                    enabled: api.mediaOptionSupported("outputTemplate")
                                    onClicked: outputTemplate.text = "%(title)s.%(ext)s"
                                }
                                Button {
                                    text: root.t("media.templateCreator")
                                    enabled: api.mediaOptionSupported("outputTemplate")
                                    onClicked: outputTemplate.text = "%(uploader)s - %(title)s.%(ext)s"
                                }
                                Button {
                                    text: root.t("media.templateIndex")
                                    enabled: api.mediaOptionSupported("outputTemplate")
                                    onClicked: outputTemplate.text = "%(playlist_index)s - %(title)s.%(ext)s"
                                }
                                Item { Layout.fillWidth: true }
                            }

                            TextField {
                                id: outputTemplate
                                Layout.fillWidth: true
                                text: "%(title)s.%(ext)s"
                                Accessible.name: root.t("media.outputTemplate")
                                enabled: api.mediaOptionSupported("outputTemplate")
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

                            Text { text: root.t("media.playlistItems"); color: Theme.textMuted; font.pixelSize: Theme.fontTiny }
                            TextField {
                                id: playlistItems
                                Layout.fillWidth: true
                                readOnly: true
                                text: root.selectAllPlaylist
                                    ? root.t("media.allPlaylistItems")
                                    : root.playlistItemsValue()
                                placeholderText: root.t("media.selectPlaylistItems")
                                Accessible.name: root.t("media.playlistItems")
                                LayoutMirroring.enabled: false
                                horizontalAlignment: Text.AlignLeft
                            }
                        }

                        Flow {
                            Layout.fillWidth: true
                            spacing: 8

                            CheckBox {
                                id: subtitlesCheck
                                text: root.t("media.subtitles")
                                Accessible.name: text
                                enabled: api.mediaOptionSupported("subtitles")
                            }

                            CheckBox {
                                id: embedSubtitlesCheck
                                text: root.t("media.embedSubtitles")
                                Accessible.name: text
                                enabled: subtitlesCheck.checked
                                    && modeBox.currentIndex === 0
                                    && root.localSubtitleContainerAvailable(videoContainerBox.currentValue)
                                    && api.mediaOptionSupported("embedSubtitles")
                            }

                            CheckBox {
                                id: thumbnailCheck
                                text: root.t("media.thumbnail")
                                Accessible.name: text
                                enabled: api.mediaOptionSupported("writeThumbnail")
                            }

                            CheckBox {
                                id: embedThumbnailCheck
                                text: root.t("media.embedThumbnail")
                                Accessible.name: text
                                enabled: thumbnailCheck.checked
                                    && api.mediaOptionSupported("embedThumbnail")
                            }

                            CheckBox {
                                id: infoJsonCheck
                                text: root.t("media.infoJson")
                                Accessible.name: text
                                enabled: api.mediaOptionSupported("writeInfoJson")
                            }

                            CheckBox {
                                id: descriptionCheck
                                text: root.t("media.description")
                                Accessible.name: text
                                enabled: api.mediaOptionSupported("writeDescription")
                            }
                        }

                        TextField {
                            id: subtitleLanguages
                            Layout.fillWidth: true
                            visible: subtitlesCheck.checked
                            enabled: api.mediaOptionSupported("subtitleLanguages")
                            placeholderText: root.t("media.subtitleLanguages")
                            Accessible.name: root.t("media.subtitleLanguages")
                            selectByMouse: true
                            LayoutMirroring.enabled: false
                            horizontalAlignment: Text.AlignLeft
                        }

                        MediaAdvancedPanel {
                            id: mediaAdvanced
                            Layout.fillWidth: true
                            api: root.api
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
                            text: root.playlistMode ? root.t("media.playlistPreview") : root.t("media.mediaPreview")
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
                                            ? (api.mediaPlaylistTitle || root.t("media.inspectPlaylist"))
                                            : (api.mediaProbe.title || root.t("media.inspectMedia"))
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
                                                + api.mediaFormats.length + " " + root.t("media.videoQualities")
                                            : api.mediaFormats.length + " " + root.t("media.videoQualities")
                                        color: Theme.textMuted
                                        font.pixelSize: Theme.fontTiny
                                    }

                                    Text {
                                        visible: root.playlistMode
                                        text: api.mediaPlaylistEntries.length + " " + root.t("media.items")
                                        color: Theme.textMuted
                                        font.pixelSize: Theme.fontTiny
                                    }
                                }
                            }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            visible: root.playlistMode && api.mediaPlaylistEntries.length > 0

                            Text {
                                text: root.selectAllPlaylist
                                    ? api.mediaPlaylistEntries.length + " " + root.t("media.selected")
                                    : root.playlistSelectionCount() + " " + root.t("media.selected")
                                color: Theme.textMuted
                                font.pixelSize: Theme.fontTiny
                            }

                            Item { Layout.fillWidth: true }

                            Button {
                                text: root.selectAllPlaylist
                                    ? root.t("media.all")
                                    : root.t("media.custom")
                                enabled: api.mediaOptionSupported("playlistItems")
                                onClicked: {
                                    root.selectAllPlaylist = !root.selectAllPlaylist
                                    root.selectedPlaylistIndexes = ({})
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
                            activeFocusOnTab: true
                            keyNavigationWraps: false
                            Accessible.role: Accessible.List
                            Accessible.name: root.playlistMode
                                ? root.t("media.playlistPreview")
                                : root.t("media.mediaPreview")
                            onActiveFocusChanged: {
                                if (activeFocus && count > 0 && currentIndex < 0)
                                    currentIndex = 0
                            }
                            Keys.onPressed: event => {
                                if (!root.playlistMode
                                    || root.selectAllPlaylist
                                    || !api.mediaOptionSupported("playlistItems")
                                    || currentIndex < 0
                                    || currentIndex >= count) {
                                    return
                                }
                                if (event.key === Qt.Key_Space || event.key === Qt.Key_Return
                                    || event.key === Qt.Key_Enter) {
                                    const entry = api.mediaPlaylistEntries[currentIndex]
                                    if (entry)
                                        root.togglePlaylistItem(Number(entry.index))
                                    event.accepted = true
                                }
                            }
                            ScrollBar.vertical: ScrollBar {}

                            delegate: Rectangle {
                                required property int index
                                required property var modelData
                                width: previewList.width
                                height: 50
                                radius: Theme.radiusSmall
                                color: Theme.surfaceRaised
                                border.width: previewList.activeFocus
                                    && previewList.currentIndex === index ? 2 : 1
                                border.color: previewList.activeFocus
                                    && previewList.currentIndex === index
                                    ? Theme.focusRing : Theme.border
                                Accessible.role: Accessible.ListItem
                                Accessible.name: root.playlistMode
                                    ? (modelData.title || modelData.id || root.t("media.playlistItem"))
                                    : (modelData.height + "p · "
                                        + String(modelData.ext || "").toUpperCase())
                                Accessible.description: root.playlistMode
                                    ? (modelData.durationString || modelData.url || "")
                                    : ((modelData.vcodec || "") + " · "
                                        + root.formatBytes(modelData.filesize))
                                Accessible.focusable: true
                                Accessible.focused: previewList.activeFocus
                                    && previewList.currentIndex === index
                                Accessible.selectable: true
                                Accessible.selected: previewList.currentIndex === index
                                Accessible.onPressAction: {
                                    previewList.currentIndex = index
                                    if (root.playlistMode && !root.selectAllPlaylist
                                        && api.mediaOptionSupported("playlistItems")) {
                                        root.togglePlaylistItem(Number(modelData.index))
                                    }
                                }

                                RowLayout {
                                    anchors.fill: parent
                                    anchors.leftMargin: 10
                                    anchors.rightMargin: 10
                                    spacing: 10

                                    Button {
                                        visible: root.playlistMode
                                        enabled: !root.selectAllPlaylist
                                            && api.mediaOptionSupported("playlistItems")
                                        text: root.selectAllPlaylist
                                            || root.selectedPlaylistIndexes[String(modelData.index)]
                                            ? "✓"
                                            : "○"
                                        implicitWidth: 34
                                        Accessible.name: (modelData.title || root.t("media.playlistItem"))
                                            + " — " + (root.selectAllPlaylist
                                                || root.selectedPlaylistIndexes[String(modelData.index)]
                                                ? root.t("media.selected")
                                                : root.t("common.no"))
                                        onClicked: root.togglePlaylistItem(Number(modelData.index))
                                    }

                                    ColumnLayout {
                                        Layout.fillWidth: true
                                        spacing: 1

                                        Text {
                                            Layout.fillWidth: true
                                            text: root.playlistMode
                                                ? (modelData.title || modelData.id || root.t("media.playlistItem"))
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
                    ? root.t("media.daemonAnalyzing")
                    : root.t("media.daemonExecution")
                color: Theme.textMuted
                font.pixelSize: Theme.fontTiny
            }

            Item { Layout.fillWidth: true }

            Button {
                text: root.t("media.start")
                enabled: api.connected
                    && root.capabilitySupported("media.extraction")
                    && api.controlPlaneCommandSupported(playlistMode ? "addMediaPlaylist" : "addMediaDownload")
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
