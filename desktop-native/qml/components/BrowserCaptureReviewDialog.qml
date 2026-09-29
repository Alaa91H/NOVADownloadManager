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
    property bool submitting: false
    property string errorText: ""

    modal: true
    focus: true
    closePolicy: Popup.NoAutoClose
    width: Math.min(600, parent ? parent.width - 48 : 600)
    title: root.t("captureReview.title")

    function t(key) {
        return i18n.translate(key)
    }

    function openForReview(item) {
        review = item || ({})
        errorText = ""
        submitting = false
        const base = String(settings.defaultSaveDirectory || "").trim()
        const fileName = String(review.name || "download").trim()
        nameField.text = fileName
        pathField.text = isTorrent
            ? base
            : (base.length > 0 ? base.replace(/[\\/]+$/, "") + "/" : "") + fileName
        open()
    }

    function submit(startNow) {
        if (submitting)
            return
        const id = String(review.reviewId || "").trim()
        const path = pathField.text.trim()
        if (id.length === 0) {
            errorText = root.t("captureReview.invalid")
            return
        }
        if (isTorrent && path.length === 0) {
            errorText = root.t("captureReview.chooseDirectory")
            return
        }
        errorText = ""
        submitting = true
        api.consumeCaptureReview(
            id,
            nameField.text,
            path,
            startNow,
            Math.max(1, Number(settings.defaultConnections || 8))
        )
    }

    function dismiss() {
        const id = String(review.reviewId || "").trim()
        if (id.length > 0)
            api.discardCaptureReview(id)
        submitting = true
    }

    readonly property bool isMagnet: String(review.url || "").toLowerCase().startsWith("magnet:")
    readonly property bool isTorrent: isMagnet
        || String(review.fileType || "").toLowerCase() === "torrent"

    background: Rectangle {
        color: Theme.surfaceRaised
        border.color: Theme.borderStrong
        border.width: 1
        radius: Theme.radiusLarge
    }

    contentItem: ColumnLayout {
        spacing: 12

        Text {
            Layout.fillWidth: true
            text: root.t("captureReview.heading")
            color: Theme.textPrimary
            font.pixelSize: Math.round(18 * Theme.fontScale)
            font.weight: Font.DemiBold
        }

        Text {
            Layout.fillWidth: true
            text: root.t("captureReview.subtitle")
            color: Theme.textMuted
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.WordWrap
        }

        TextField {
            Layout.fillWidth: true
            text: String(root.review.url || "")
            readOnly: true
            selectByMouse: true
            Accessible.name: root.t("captureReview.source")
            LayoutMirroring.enabled: false
            horizontalAlignment: Text.AlignLeft
        }

        TextField {
            id: nameField
            Layout.fillWidth: true
            placeholderText: root.t("captureReview.fileName")
            selectByMouse: true
            Accessible.name: root.t("captureReview.fileName")
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            TextField {
                id: pathField
                Layout.fillWidth: true
                placeholderText: root.isTorrent
                    ? root.t("captureReview.chooseDirectory")
                    : root.t("common.savePath")
                selectByMouse: true
                Accessible.name: root.isTorrent
                    ? root.t("captureReview.destinationDirectory")
                    : root.t("common.savePath")
                LayoutMirroring.enabled: false
                horizontalAlignment: Text.AlignLeft
            }

            Button {
                text: root.t("common.browse")
                enabled: !root.submitting
                Accessible.name: text
                onClicked: {
                    const base = pathField.text.trim() || String(settings.defaultSaveDirectory || "")
                    if (root.isTorrent) {
                        const chosen = desktop.chooseDirectory(base)
                        if (chosen.length > 0)
                            pathField.text = chosen
                    } else {
                        let suggested = base
                        if (suggested.length === 0)
                            suggested = String(settings.defaultSaveDirectory || "")
                        if (suggested.length === 0)
                            suggested = nameField.text.trim()
                        const chosen = desktop.chooseSaveFile(suggested, "All files (*)")
                        if (chosen.length > 0)
                            pathField.text = chosen
                    }
                }
            }
        }

        Text {
            Layout.fillWidth: true
            visible: root.isTorrent
            text: root.t("captureReview.torrentNote")
            color: Theme.textMuted
            font.pixelSize: Theme.fontTiny
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

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 4

            Button {
                text: root.t("captureReview.dismiss")
                enabled: !root.submitting
                onClicked: root.dismiss()
            }

            Item { Layout.fillWidth: true }

            Button {
                text: root.t("captureReview.queue")
                enabled: !root.submitting
                onClicked: root.submit(false)
            }

            Button {
                text: root.submitting ? root.t("captureReview.adding") : root.t("captureReview.start")
                enabled: !root.submitting
                onClicked: root.submit(true)

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

        function onCaptureReviewConsumed(reviewId, taskId) {
            if (String(root.review.reviewId || "") !== reviewId)
                return
            root.submitting = false
            root.close()
        }

        function onCaptureReviewDiscarded(reviewId) {
            if (String(root.review.reviewId || "") !== reviewId)
                return
            root.submitting = false
            root.close()
        }

        function onCaptureReviewActionFailed(reviewId, message) {
            if (String(root.review.reviewId || "") !== reviewId)
                return
            root.submitting = false
            root.errorText = message
        }
    }
}
