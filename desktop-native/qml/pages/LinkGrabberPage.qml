import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Item {
    id: root

    required property var api
    required property var settings

    property string errorText: ""
    property string statusText: ""

    function formatBytes(value) {
        const bytes = Number(value || 0)
        if (bytes <= 0) return "Unknown"
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
                text: "Link Grabber"
                color: Theme.textPrimary
                font.pixelSize: 21
                font.weight: Font.DemiBold
            }

            Text {
                text: "Resolve redirects, interstitials and download metadata through the NOVA probe pipeline"
                color: Theme.textMuted
                font.pixelSize: 10
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
                    onAccepted: root.analyze()
                }

                Button {
                    text: api.directProbeBusy ? "Analyzing…" : "Analyze link"
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
                            text: api.directProbe.fileName || "No analyzed link"
                            color: Theme.textPrimary
                            font.pixelSize: 15
                            font.weight: Font.DemiBold
                            elide: Text.ElideMiddle
                        }

                        Text {
                            Layout.fillWidth: true
                            text: api.directProbe.finalUrl || api.directProbe.url
                                || "Analyze a link to inspect the resolved target."
                            color: Theme.textMuted
                            font.pixelSize: 9
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
                            font.pixelSize: 9
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
                            { label: "Size", value: root.formatBytes(api.directProbe.sizeBytes) },
                            { label: "Resumable", value: api.directProbe.resumable ? "Yes" : "No" },
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
                                    font.pixelSize: 8
                                    font.weight: Font.DemiBold
                                }

                                Text {
                                    Layout.fillWidth: true
                                    text: modelData.value
                                    color: Theme.textPrimary
                                    font.pixelSize: 10
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

                        TextField {
                            id: saveDirectory
                            Layout.fillWidth: true
                            placeholderText: "Optional destination directory"
                            selectByMouse: true
                        }

                        CheckBox {
                            id: startImmediately
                            text: "Start immediately"
                            checked: true
                        }

                        Button {
                            text: "Add download"
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
                                font.pixelSize: 11
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
                    font.pixelSize: 10
                    wrapMode: Text.WordWrap
                }

                Text {
                    Layout.fillWidth: true
                    visible: root.statusText.length > 0
                    text: root.statusText
                    color: Theme.success
                    font.pixelSize: 10
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
                    text: "No link analyzed yet"
                    color: Theme.textPrimary
                    font.pixelSize: 15
                    font.weight: Font.DemiBold
                }

                Text {
                    text: "The daemon will resolve redirects and inspect file metadata."
                    color: Theme.textMuted
                    font.pixelSize: 9
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
