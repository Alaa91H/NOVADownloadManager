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

    function analyze() {
        const url = urlField.text.trim()
        if (url.length === 0) {
            errorText = "Enter a URL."
            return
        }

        errorText = ""
        statusText = ""
        api.probeDirectLink(url)
    }

    Component.onCompleted: {
        saveDirectory.text = settings.defaultSaveDirectory
        startImmediately.checked = settings.startImmediately
    }

    Connections {
        target: api

        function onDirectProbeFailed(message) {
            root.errorText = message
            root.statusText = ""
        }

        function onDirectDownloadCreated(taskId) {
            root.statusText = "Download task created · " + taskId
            root.errorText = ""
        }

        function onRequestFailed(message) {
            if (root.visible) {
                root.errorText = message
                root.statusText = ""
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 12

        ColumnLayout {
            spacing: 2

            Text {
                text: root.t("grabber.title")
                color: Theme.textPrimary
                font.pixelSize: Theme.fontTitle
                font.weight: Font.DemiBold
            }

            Text {
                text: root.t("grabber.subtitle")
                color: Theme.textMuted
                font.pixelSize: Theme.fontSmall
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
                    placeholderText: "https://example.com/download"
                    selectByMouse: true
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                    Accessible.name: root.t("add.url")
                    onAccepted: root.analyze()
                }

                Button {
                    text: api.directProbeBusy ? root.t("grabber.analyzing") : root.t("grabber.analyze")
                    enabled: api.connected
                        && !api.directProbeBusy
                        && urlField.text.trim().length > 0
                    onClicked: root.analyze()
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            radius: Theme.radiusMedium
            color: Theme.surface
            border.color: Theme.border

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 14
                spacing: 10

                RowLayout {
                    Layout.fillWidth: true

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2

                        Text {
                            Layout.fillWidth: true
                            text: api.directProbe.fileName || root.t("grabber.noLink")
                            color: Theme.textPrimary
                            font.pixelSize: Theme.fontMedium
                            font.weight: Font.DemiBold
                            elide: Text.ElideMiddle
                        }

                        Text {
                            Layout.fillWidth: true
                            text: api.directProbe.finalUrl || api.directProbe.url
                                || "Analyze a link to inspect the resolved target."
                            LayoutMirroring.enabled: false
                            horizontalAlignment: Text.AlignLeft
                            color: Theme.textMuted
                            font.pixelSize: Theme.fontTiny
                            elide: Text.ElideMiddle
                        }
                    }

                    Rectangle {
                        visible: api.directProbe.httpStatus !== undefined
                            && Number(api.directProbe.httpStatus) > 0
                        implicitWidth: statusCode.implicitWidth + 18
                        implicitHeight: 24
                        radius: 12
                        color: Theme.surfaceRaised
                        border.color: Theme.border

                        Text {
                            id: statusCode
                            anchors.centerIn: parent
                            text: "HTTP " + api.directProbe.httpStatus
                            color: Number(api.directProbe.httpStatus) < 400
                                ? Theme.success
                                : Theme.warning
                            font.pixelSize: Theme.fontTiny
                            font.weight: Font.DemiBold
                        }
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 1
                    color: Theme.border
                }

                GridLayout {
                    Layout.fillWidth: true
                    columns: 4
                    columnSpacing: 10
                    rowSpacing: 10

                    Repeater {
                        model: [
                            { label: "Type", value: api.directProbe.fileType || "Unknown" },
                            { label: root.t("common.size"), value: root.formatBytes(api.directProbe.sizeBytes) },
                            { label: root.t("common.resumable"), value: api.directProbe.resumable ? root.t("common.yes") : root.t("common.no") },
                            { label: "Segments", value: api.directProbe.supportsSegments ? "Supported" : "Unknown / no" },
                            { label: "Content type", value: api.directProbe.contentType || "Unknown" },
                            { label: "Probe method", value: api.directProbe.probeMethod || "—" },
                            { label: "ETag", value: api.directProbe.etag || "—" },
                            { label: "Mirrors", value: api.directProbe.linkMirrors ? String(api.directProbe.linkMirrors.length) : "0" }
                        ]

                        delegate: Rectangle {
                            required property var modelData
                            Layout.fillWidth: true
                            Layout.preferredHeight: 64
                            radius: Theme.radiusSmall
                            color: Theme.surfaceRaised
                            border.color: Theme.border

                            ColumnLayout {
                                anchors.fill: parent
                                anchors.margins: 9
                                spacing: 2

                                Text {
                                    text: modelData.label
                                    color: Theme.textMuted
                                    font.pixelSize: Math.max(8, Theme.fontTiny - 1)
                                    font.weight: Font.DemiBold
                                }

                                Text {
                                    Layout.fillWidth: true
                                    text: modelData.value
                                    color: Theme.textPrimary
                                    font.pixelSize: Theme.fontSmall
                                    font.weight: Font.Medium
                                    elide: Text.ElideMiddle
                                }
                            }
                        }
                    }
                }

                Item { Layout.fillHeight: true }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: optionRow.implicitHeight + 18
                    radius: Theme.radiusMedium
                    color: Theme.surfaceRaised
                    border.color: Theme.border

                    RowLayout {
                        id: optionRow
                        anchors.fill: parent
                        anchors.margins: 9
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

                        CheckBox {
                            id: startImmediately
                            text: root.t("common.startImmediately")
                            checked: true
                        }

                        Button {
                            text: root.t("common.addDownload")
                            enabled: api.connected
                                && !api.directProbeBusy
                                && api.directProbe
                                && Object.keys(api.directProbe).length > 0
                            onClicked: {
                                root.errorText = ""
                                root.statusText = "Creating download task…"
                                api.createDirectFromProbe(
                                    saveDirectory.text,
                                    startImmediately.checked
                                )
                            }

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
            }

            ColumnLayout {
                anchors.centerIn: parent
                visible: (!api.directProbe || Object.keys(api.directProbe).length === 0)
                    && !api.directProbeBusy
                spacing: 5

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: root.t("grabber.noLink")
                    color: Theme.textPrimary
                    font.pixelSize: Theme.fontMedium
                    font.weight: Font.DemiBold
                }

                Text {
                    text: root.t("grabber.noLinkSubtitle")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontTiny
                }
            }

            BusyIndicator {
                anchors.centerIn: parent
                visible: api.directProbeBusy
                running: visible
            }
        }
    }
}
