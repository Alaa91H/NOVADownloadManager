import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Nova.Native

Rectangle {
    id: root

    required property var api
    property string languageToken: i18n.language
    property var capabilitySnapshot: api.engineCapabilities

    radius: Theme.radiusMedium
    color: Theme.surface
    border.color: Theme.border
    implicitHeight: content.implicitHeight + 20

    function t(key) {
        const token = root.languageToken
        return i18n.translate(key)
    }

    function supports(key) {
        const snapshot = root.capabilitySnapshot
        return api.mediaOptionSupported(key)
    }

    function putText(target, key, field) {
        const value = field.text.trim()
        if (value.length > 0)
            target[key] = value
    }

    function putPositive(target, key, field) {
        const value = Number(field.value)
        if (value > 0)
            target[key] = value
    }

    function buildOptions() {
        const options = {}

        if (autoSubtitlesCheck.checked)
            options.autoSubtitles = true
        if (splitChaptersCheck.checked)
            options.splitChapters = true

        putText(options, "formatSelector", formatSelectorField)
        putText(options, "formatSort", formatSortField)
        putText(options, "downloadSections", downloadSectionsField)
        putText(options, "matchFilter", matchFilterField)
        putText(options, "remuxFormat", remuxFormatField)
        putText(options, "sponsorBlock", sponsorBlockField)

        putText(options, "proxy", proxyField)
        putText(options, "cookiesFromBrowser", cookiesBrowserField)
        putText(options, "userAgent", userAgentField)
        putText(options, "referer", refererField)
        putText(options, "headers", headersField)
        putText(options, "cookies", cookiesField)

        putPositive(options, "rateLimitKbs", rateLimitField)
        putPositive(options, "retries", retriesField)
        putPositive(options, "fragmentRetries", fragmentRetriesField)
        putPositive(options, "concurrentFragments", concurrentFragmentsField)
        putPositive(options, "sleepIntervalSec", sleepIntervalField)
        putPositive(options, "maxSleepIntervalSec", maxSleepIntervalField)

        return options
    }

    ColumnLayout {
        id: content
        anchors.fill: parent
        anchors.margins: 10
        spacing: 10

        RowLayout {
            Layout.fillWidth: true

            Text {
                text: root.t("media.advanced")
                color: Theme.textPrimary
                font.pixelSize: Theme.fontBody
                font.weight: Font.DemiBold
            }

            Item { Layout.fillWidth: true }

            Text {
                text: root.t("media.capabilityAware")
                color: Theme.textMuted
                font.pixelSize: Theme.fontTiny
            }
        }

        TabBar {
            id: tabs
            Layout.fillWidth: true

            TabButton { text: root.t("media.advancedSubtitles") }
            TabButton { text: root.t("media.advancedFormat") }
            TabButton { text: root.t("media.advancedNetwork") }
            TabButton { text: root.t("media.advancedPerformance") }
        }

        StackLayout {
            Layout.fillWidth: true
            currentIndex: tabs.currentIndex

            ColumnLayout {
                spacing: 8

                CheckBox {
                    id: autoSubtitlesCheck
                    text: root.t("media.autoSubtitles")
                    enabled: root.supports("autoSubtitles")
                    Accessible.name: text
                }

                CheckBox {
                    id: splitChaptersCheck
                    text: root.t("media.splitChapters")
                    enabled: root.supports("splitChapters")
                    Accessible.name: text
                }

                Text {
                    Layout.fillWidth: true
                    text: root.t("media.advancedSubtitlesHint")
                    color: Theme.textMuted
                    font.pixelSize: Theme.fontTiny
                    wrapMode: Text.WordWrap
                }
            }

            GridLayout {
                columns: 2
                columnSpacing: 10
                rowSpacing: 8

                Text { text: root.t("media.formatSelector"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                TextField {
                    id: formatSelectorField
                    Layout.fillWidth: true
                    placeholderText: "bestvideo+bestaudio/best"
                    enabled: root.supports("formatSelector")
                    selectByMouse: true
                    font.family: "monospace"
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text { text: root.t("media.formatSort"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                TextField {
                    id: formatSortField
                    Layout.fillWidth: true
                    placeholderText: "res,codec:avc:m4a"
                    enabled: root.supports("formatSort")
                    selectByMouse: true
                    font.family: "monospace"
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text { text: root.t("media.downloadSections"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                TextField {
                    id: downloadSectionsField
                    Layout.fillWidth: true
                    placeholderText: "*00:01:00-00:03:00"
                    enabled: root.supports("downloadSections")
                    selectByMouse: true
                    font.family: "monospace"
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text { text: root.t("media.matchFilter"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                TextField {
                    id: matchFilterField
                    Layout.fillWidth: true
                    placeholderText: "duration < 3600"
                    enabled: root.supports("matchFilter")
                    selectByMouse: true
                    font.family: "monospace"
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text { text: root.t("media.remuxFormat"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                TextField {
                    id: remuxFormatField
                    Layout.fillWidth: true
                    placeholderText: "mp4"
                    enabled: root.supports("remuxFormat")
                    selectByMouse: true
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text { text: root.t("media.sponsorBlock"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                TextField {
                    id: sponsorBlockField
                    Layout.fillWidth: true
                    placeholderText: "sponsor,selfpromo"
                    enabled: root.supports("sponsorBlock")
                    selectByMouse: true
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }
            }

            GridLayout {
                columns: 2
                columnSpacing: 10
                rowSpacing: 8

                Text { text: root.t("media.proxy"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                TextField {
                    id: proxyField
                    Layout.fillWidth: true
                    placeholderText: "https://proxy.example:8080"
                    enabled: root.supports("proxy")
                    selectByMouse: true
                    font.family: "monospace"
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text { text: root.t("media.cookiesBrowser"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                ComboBox {
                    id: cookiesBrowserField
                    Layout.fillWidth: true
                    editable: true
                    enabled: root.supports("cookiesFromBrowser")
                    model: ["", "chrome", "edge", "firefox", "brave", "chromium", "opera", "vivaldi", "safari"]
                }

                Text { text: root.t("media.userAgent"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                TextField {
                    id: userAgentField
                    Layout.fillWidth: true
                    enabled: root.supports("userAgent")
                    selectByMouse: true
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text { text: root.t("media.referer"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                TextField {
                    id: refererField
                    Layout.fillWidth: true
                    placeholderText: "https://example.com/page"
                    enabled: root.supports("referer")
                    selectByMouse: true
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text { text: root.t("media.headers"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                TextArea {
                    id: headersField
                    Layout.fillWidth: true
                    Layout.preferredHeight: 64
                    placeholderText: "Header-Name: value"
                    enabled: root.supports("headers")
                    wrapMode: TextEdit.NoWrap
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }

                Text { text: root.t("media.cookies"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                TextArea {
                    id: cookiesField
                    Layout.fillWidth: true
                    Layout.preferredHeight: 64
                    placeholderText: "name=value"
                    enabled: root.supports("cookies")
                    wrapMode: TextEdit.NoWrap
                    LayoutMirroring.enabled: false
                    horizontalAlignment: Text.AlignLeft
                }
            }

            GridLayout {
                columns: 4
                columnSpacing: 10
                rowSpacing: 8

                Text { text: root.t("media.rateLimit"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                SpinBox {
                    id: rateLimitField
                    from: 0
                    to: 10000000
                    value: 0
                    enabled: root.supports("rateLimitKbs")
                }

                Text { text: root.t("media.retries"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                SpinBox {
                    id: retriesField
                    from: 0
                    to: 1000
                    value: 0
                    enabled: root.supports("retries")
                }

                Text { text: root.t("media.fragmentRetries"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                SpinBox {
                    id: fragmentRetriesField
                    from: 0
                    to: 1000
                    value: 0
                    enabled: root.supports("fragmentRetries")
                }

                Text { text: root.t("media.concurrentFragments"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                SpinBox {
                    id: concurrentFragmentsField
                    from: 0
                    to: 64
                    value: 0
                    enabled: root.supports("concurrentFragments")
                }

                Text { text: root.t("media.sleepInterval"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                SpinBox {
                    id: sleepIntervalField
                    from: 0
                    to: 86400
                    value: 0
                    enabled: root.supports("sleepIntervalSec")
                }

                Text { text: root.t("media.maxSleepInterval"); color: Theme.textSecondary; font.pixelSize: Theme.fontSmall }
                SpinBox {
                    id: maxSleepIntervalField
                    from: 0
                    to: 86400
                    value: 0
                    enabled: root.supports("maxSleepIntervalSec")
                }
            }
        }
    }
}
