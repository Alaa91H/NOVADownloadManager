#include "localization/LegacyI18nCatalog.h"

#include <QFile>
#include <QLocale>
#include <QRegularExpression>
#include <QVariantMap>

namespace {
QString resourceCodeForLegacyLanguage(QString code) {
    code.replace(QLatin1Char('-'), QLatin1Char('_'));
    return code;
}

void appendLanguage(
    QHash<QString, QString> &resourceFileByCode,
    QSet<QString> &rtlLanguages,
    QVariantList &supportedLanguages,
    const QString &rawCode,
    const QString &label,
    bool rtl
) {
    const QString code = rawCode.trimmed().toLower();
    if (code.isEmpty() || resourceFileByCode.contains(code)) {
        return;
    }

    resourceFileByCode.insert(
        code,
        QStringLiteral(":/legacy-i18n/%1.ts").arg(resourceCodeForLegacyLanguage(rawCode))
    );
    if (rtl) {
        rtlLanguages.insert(code);
    }
    supportedLanguages.append(
        QVariantMap{
            {QStringLiteral("code"), code},
            {QStringLiteral("label"), label}
        }
    );
}
const QHash<QString, QString> &nativeLegacyAliases() {
    static const QHash<QString, QString> aliases{
        {QStringLiteral("nav.downloads"), QStringLiteral("all_downloads")},
        {QStringLiteral("nav.queue"), QStringLiteral("nav_queues")},
        {QStringLiteral("nav.scheduler"), QStringLiteral("scheduler")},
        {QStringLiteral("action.redownload"), QStringLiteral("menu_redownload")},
        {QStringLiteral("action.folder"), QStringLiteral("menu_open_file_location")},
        {QStringLiteral("common.browse"), QStringLiteral("ui_browse")},
        {QStringLiteral("common.savePath"), QStringLiteral("task_save_path")},
        {QStringLiteral("common.addDownload"), QStringLiteral("add_download")},
        {QStringLiteral("downloads.title"), QStringLiteral("all_downloads")},
        {QStringLiteral("downloads.completedTitle"), QStringLiteral("completed")},
        {QStringLiteral("downloads.dateAdded"), QStringLiteral("col_date_added")},
        {QStringLiteral("downloads.elapsed"), QStringLiteral("col_elapsed")},
        {QStringLiteral("downloads.retries"), QStringLiteral("col_retries")},
        {QStringLiteral("downloads.priority"), QStringLiteral("col_priority")},
        {QStringLiteral("downloads.completedDate"), QStringLiteral("col_date_completed")},
        {QStringLiteral("downloads.smartCategory"), QStringLiteral("col_smart_category")},
        {QStringLiteral("add.fileName"), QStringLiteral("task_file_name")},
        {QStringLiteral("add.downloadNow"), QStringLiteral("add_dl_start_now")},
        {QStringLiteral("redownload.retryTitle"), QStringLiteral("menu_retry_download")},
        {QStringLiteral("properties.save"), QStringLiteral("task_save_changes")},
        {QStringLiteral("details.openFile"), QStringLiteral("menu_open_file")},
        {QStringLiteral("details.showFolder"), QStringLiteral("menu_open_file_location")},
        {QStringLiteral("queue.start"), QStringLiteral("sched_start_queue")},
        {QStringLiteral("queue.stop"), QStringLiteral("sched_stop_queue")},
        {QStringLiteral("queue.maxActive"), QStringLiteral("sched_max_concurrent")},
        {QStringLiteral("queue.retries"), QStringLiteral("sched_retries_title")},
        {QStringLiteral("queue.retryDelay"), QStringLiteral("sched_retry_wait")},
        {QStringLiteral("queue.completionActions"), QStringLiteral("sched_actions_on_complete")},
        {QStringLiteral("queue.shutdown"), QStringLiteral("sched_action_shutdown")},
        {QStringLiteral("queue.sleep"), QStringLiteral("progress_sleep")},
        {QStringLiteral("scheduler.title"), QStringLiteral("scheduler")},
        {QStringLiteral("scheduler.selectQueue"), QStringLiteral("sched_select_queue")},
        {QStringLiteral("scheduler.shutdown"), QStringLiteral("progress_shutdown")},
        {QStringLiteral("scheduler.sleep"), QStringLiteral("progress_sleep")},
        {QStringLiteral("scheduler.notification"), QStringLiteral("statusbar_notifications_title")},
        {QStringLiteral("batch.destination"), QStringLiteral("batch_save_dir")},
        {QStringLiteral("batch.paste"), QStringLiteral("batch_paste")},
        {QStringLiteral("batch.queueId"), QStringLiteral("batch_queue")},
        {QStringLiteral("media.formatSelector"), QStringLiteral("media_adv_format_selector")},
        {QStringLiteral("media.formatSort"), QStringLiteral("media_adv_format_sort")},
        {QStringLiteral("media.downloadSections"), QStringLiteral("media_adv_download_sections")},
        {QStringLiteral("media.matchFilter"), QStringLiteral("media_adv_match_filter")},
        {QStringLiteral("media.remuxFormat"), QStringLiteral("media_adv_remux_format")},
        {QStringLiteral("media.sponsorBlock"), QStringLiteral("media_adv_sponsorblock_segments")},
        {QStringLiteral("media.proxy"), QStringLiteral("media_adv_proxy")},
        {QStringLiteral("media.userAgent"), QStringLiteral("media_adv_user_agent")},
        {QStringLiteral("media.referer"), QStringLiteral("media_adv_referer")},
        {QStringLiteral("media.headers"), QStringLiteral("media_adv_custom_headers")},
        {QStringLiteral("media.cookies"), QStringLiteral("media_adv_cookies")},
        {QStringLiteral("media.rateLimit"), QStringLiteral("media_adv_rate_limit_kbs")},
        {QStringLiteral("media.retries"), QStringLiteral("media_adv_retries")},
        {QStringLiteral("media.fragmentRetries"), QStringLiteral("media_adv_fragment_retries")},
        {QStringLiteral("media.concurrentFragments"), QStringLiteral("media_adv_concurrent_fragments")},
        {QStringLiteral("media.sleepInterval"), QStringLiteral("media_adv_sleep_interval_seconds")},
        {QStringLiteral("media.maxSleepInterval"), QStringLiteral("media_adv_max_sleep_seconds")},
        {QStringLiteral("media.embedSubtitles"), QStringLiteral("media_adv_embed_subtitles")},
        {QStringLiteral("media.thumbnail"), QStringLiteral("media_adv_write_thumbnail")},
        {QStringLiteral("media.embedThumbnail"), QStringLiteral("media_adv_embed_thumbnail")},
        {QStringLiteral("media.infoJson"), QStringLiteral("media_adv_write_info_json")},
        {QStringLiteral("media.description"), QStringLiteral("media_adv_write_description")},
        {QStringLiteral("media.subtitleLanguages"), QStringLiteral("media_adv_subtitle_languages")},
        {QStringLiteral("settings.general"), QStringLiteral("set_tab_general")},
        {QStringLiteral("settings.engine"), QStringLiteral("set_tab_engines")},
        {QStringLiteral("settings.language"), QStringLiteral("settings_interface_language")},
        {QStringLiteral("settings.highContrast"), QStringLiteral("set_theme_contrast_high")},
        {QStringLiteral("settings.closeToTray"), QStringLiteral("set_tray_icon")},
        {QStringLiteral("settings.enableNotifications"), QStringLiteral("settings_show_notification")},
        {QStringLiteral("settings.defaultDirectory"), QStringLiteral("settings_default_folder")},
        {QStringLiteral("settings.speedLimiter"), QStringLiteral("speed_limiter")},
        {QStringLiteral("settings.networkPerformance"), QStringLiteral("settings_performance_bandwidth")},
        {QStringLiteral("settings.proxyPort"), QStringLiteral("settings_port")},
        {QStringLiteral("settings.proxyUser"), QStringLiteral("settings_proxy_username")},
        {QStringLiteral("settings.httpVersion"), QStringLiteral("add_dl_http_version")},
        {QStringLiteral("settings.tlsMinimum"), QStringLiteral("add_dl_tls_min")},
        {QStringLiteral("settings.allowInsecureTls"), QStringLiteral("add_dl_insecure")},
        {QStringLiteral("settings.maxRedirects"), QStringLiteral("add_dl_max_redirects")},
        {QStringLiteral("settings.dnsServers"), QStringLiteral("add_dl_dns_servers")},
        {QStringLiteral("settings.keepalive"), QStringLiteral("add_dl_keepalive")},
        {QStringLiteral("settings.caCertificate"), QStringLiteral("add_dl_ca_cert")},
        {QStringLiteral("settings.clientCertificate"), QStringLiteral("add_dl_client_cert")},
        {QStringLiteral("settings.clientKey"), QStringLiteral("add_dl_client_key")},
        {QStringLiteral("settings.tlsCiphers"), QStringLiteral("add_dl_cipher_suites")},
        {QStringLiteral("settings.ffmpegAutoMerge"), QStringLiteral("settings_ffmpeg_merge")},
        {QStringLiteral("settings.telegram"), QStringLiteral("set_sub_telegram")},
        {QStringLiteral("settings.telegramEnabled"), QStringLiteral("settings_enable_telegram")},
        {QStringLiteral("settings.telegramTestOk"), QStringLiteral("settings_toast_telegram_ok")},
        {QStringLiteral("settings.shortcuts"), QStringLiteral("shortcuts_title")},
        {QStringLiteral("settings.shortcutsEnabled"), QStringLiteral("shortcuts_enable")},
        {QStringLiteral("settings.shortcutAdd"), QStringLiteral("shortcut_add_download")},
        {QStringLiteral("settings.shortcutBatch"), QStringLiteral("shortcut_batch_download")},
        {QStringLiteral("settings.shortcutSearch"), QStringLiteral("shortcut_focus_search")},
        {QStringLiteral("settings.shortcutDelete"), QStringLiteral("shortcut_delete_selected")},
        {QStringLiteral("settings.shortcutSettings"), QStringLiteral("shortcut_open_settings")},
        {QStringLiteral("settings.shortcutScheduler"), QStringLiteral("shortcut_open_scheduler")},
        {QStringLiteral("settings.shortcutSelectAll"), QStringLiteral("shortcut_select_all_downloads")},
        {QStringLiteral("settings.shortcutResumeSelected"), QStringLiteral("shortcut_resume_selected")},
        {QStringLiteral("settings.shortcutResumeAll"), QStringLiteral("shortcut_resume_all")},
        {QStringLiteral("settings.shortcutStopSelected"), QStringLiteral("shortcut_stop_selected")},
        {QStringLiteral("settings.shortcutStopAll"), QStringLiteral("shortcut_stop_all")},
        {QStringLiteral("settings.shortcutDeleteCompleted"), QStringLiteral("shortcut_delete_completed")},
        {QStringLiteral("settings.shortcutNotifications"), QStringLiteral("shortcut_toggle_notifications")},
        {QStringLiteral("settings.shortcutSpeedLimiter"), QStringLiteral("shortcut_toggle_speed_limiter")},
        {QStringLiteral("settings.backupRestore"), QStringLiteral("settings_backup_restore")},
        {QStringLiteral("settings.exportSettings"), QStringLiteral("settings_export")},
        {QStringLiteral("settings.importSettings"), QStringLiteral("settings_import")},
        {QStringLiteral("settings.factoryReset"), QStringLiteral("settings_factory_reset")},
        {QStringLiteral("settings.vpnProxyUrl"), QStringLiteral("settings_vpn_proxy")},
        {QStringLiteral("settings.pauseAll"), QStringLiteral("topbar_pause_all_tip")},
        {QStringLiteral("browser.title"), QStringLiteral("nav_browser_integration")},
        {QStringLiteral("browser.connected"), QStringLiteral("statusbar_browser_connected")},
        {QStringLiteral("browser.degraded"), QStringLiteral("statusbar_browser_degraded")},
        {QStringLiteral("browser.disconnected"), QStringLiteral("statusbar_browser_disconnected")},
    };
    return aliases;
}

}

const LegacyI18nCatalog &LegacyI18nCatalog::instance() {
    static const LegacyI18nCatalog catalog;
    return catalog;
}

LegacyI18nCatalog::LegacyI18nCatalog() {
    m_supportedLanguages.append(
        QVariantMap{
            {QStringLiteral("code"), QStringLiteral("system")},
            {QStringLiteral("label"), QStringLiteral("System")}
        }
    );

    QFile metadata(QStringLiteral(":/legacy-i18n/languageMetadata.ts"));
    if (metadata.open(QIODevice::ReadOnly | QIODevice::Text)) {
        const QString source = QString::fromUtf8(metadata.readAll());
        const QRegularExpression pattern(
            QStringLiteral(
                R"(value:\s*'([^']+)'\s+as\s+Language,\s*label:\s*'([^']+)'[^\n]*direction:\s*'(ltr|rtl)')"
            )
        );

        auto matches = pattern.globalMatch(source);
        while (matches.hasNext()) {
            const auto match = matches.next();
            appendLanguage(
                m_resourceFileByCode,
                m_rtlLanguages,
                m_supportedLanguages,
                match.captured(1),
                match.captured(2),
                match.captured(3) == QStringLiteral("rtl")
            );
        }
    }

    if (!m_resourceFileByCode.contains(QStringLiteral("en"))) {
        appendLanguage(m_resourceFileByCode, m_rtlLanguages, m_supportedLanguages,
                       QStringLiteral("en"), QStringLiteral("English"), false);
    }
    if (!m_resourceFileByCode.contains(QStringLiteral("ar"))) {
        appendLanguage(m_resourceFileByCode, m_rtlLanguages, m_supportedLanguages,
                       QStringLiteral("ar"), QStringLiteral("Arabic"), true);
    }
    if (!m_resourceFileByCode.contains(QStringLiteral("de"))) {
        appendLanguage(m_resourceFileByCode, m_rtlLanguages, m_supportedLanguages,
                       QStringLiteral("de"), QStringLiteral("German"), false);
    }

    const auto englishCatalog = parseLocaleResource(
        m_resourceFileByCode.value(QStringLiteral("en"))
    );
    m_localeCache.insert(QStringLiteral("en"), englishCatalog);
    for (auto it = englishCatalog.constBegin(); it != englishCatalog.constEnd(); ++it) {
        if (!it.value().isEmpty()) {
            m_legacyKeysByEnglish.insert(it.value(), it.key());
            const QString canonical = canonicalEnglish(it.value());
            if (!canonical.isEmpty()) {
                m_legacyKeysByCanonicalEnglish.insert(canonical, it.key());
            }
        }
    }
}

QVariantList LegacyI18nCatalog::supportedLanguages() const {
    return m_supportedLanguages;
}

QString LegacyI18nCatalog::normalizeLanguage(const QString &language) const {
    QString normalized = language.trimmed();
    if (normalized.isEmpty()
        || normalized.compare(QStringLiteral("system"), Qt::CaseInsensitive) == 0) {
        normalized = QLocale::system().name();
    }

    normalized.replace(QLatin1Char('_'), QLatin1Char('-'));
    normalized = normalized.toLower();

    if (m_resourceFileByCode.contains(normalized)) {
        return normalized;
    }

    const QString primary = normalized.section(QLatin1Char('-'), 0, 0);
    if (m_resourceFileByCode.contains(primary)) {
        return primary;
    }

    return QStringLiteral("en");
}

bool LegacyI18nCatalog::rtl(const QString &language) const {
    return m_rtlLanguages.contains(normalizeLanguage(language));
}

QString LegacyI18nCatalog::translate(
    const QString &language,
    const QString &nativeKey,
    const QString &englishValue
) const {
    const QString normalized = normalizeLanguage(language);
    if (normalized == QStringLiteral("en")) {
        return {};
    }

    const auto &dictionary = locale(normalized);
    if (dictionary.isEmpty()) {
        return {};
    }

    const auto alias = nativeLegacyAliases().constFind(nativeKey);
    if (alias != nativeLegacyAliases().constEnd()) {
        const auto translated = dictionary.constFind(alias.value());
        if (translated != dictionary.constEnd() && !translated.value().isEmpty()) {
            return translated.value();
        }
    }

    const QString directKey = legacyKeyCandidate(nativeKey);
    const auto direct = dictionary.constFind(directKey);
    if (direct != dictionary.constEnd() && !direct.value().isEmpty()) {
        return direct.value();
    }

    const QList<QString> legacyKeys = m_legacyKeysByEnglish.values(englishValue);
    for (const QString &legacyKey : legacyKeys) {
        const auto translated = dictionary.constFind(legacyKey);
        if (translated != dictionary.constEnd() && !translated.value().isEmpty()) {
            return translated.value();
        }
    }

    const QString canonical = canonicalEnglish(englishValue);
    const QList<QString> canonicalKeys = m_legacyKeysByCanonicalEnglish.values(canonical);
    for (const QString &legacyKey : canonicalKeys) {
        const auto translated = dictionary.constFind(legacyKey);
        if (translated != dictionary.constEnd() && !translated.value().isEmpty()) {
            return translated.value();
        }
    }

    return {};
}

const QHash<QString, QString> &LegacyI18nCatalog::locale(const QString &language) const {
    const QString normalized = normalizeLanguage(language);
    auto existing = m_localeCache.constFind(normalized);
    if (existing != m_localeCache.constEnd()) {
        return existing.value();
    }

    const QString resourcePath = m_resourceFileByCode.value(normalized);
    m_localeCache.insert(normalized, parseLocaleResource(resourcePath));
    return m_localeCache.constFind(normalized).value();
}

QHash<QString, QString> LegacyI18nCatalog::parseLocaleResource(const QString &resourcePath) {
    QHash<QString, QString> values;
    if (resourcePath.isEmpty()) {
        return values;
    }

    QFile file(resourcePath);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        return values;
    }

    const QString source = QString::fromUtf8(file.readAll());
    const QRegularExpression entryPattern(
        QStringLiteral(
            R"((?m)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\x60(?:\\.|[^\x60\\])*\x60)\s*,)"
        )
    );

    auto matches = entryPattern.globalMatch(source);
    while (matches.hasNext()) {
        const auto match = matches.next();
        const QString token = match.captured(2);
        if (token.size() < 2) {
            continue;
        }

        values.insert(
            match.captured(1),
            decodeJsString(token.mid(1, token.size() - 2))
        );
    }

    return values;
}

QString LegacyI18nCatalog::decodeJsString(const QString &value) {
    QString decoded;
    decoded.reserve(value.size());

    for (qsizetype i = 0; i < value.size(); ++i) {
        const QChar current = value.at(i);
        if (current != QLatin1Char('\\') || i + 1 >= value.size()) {
            decoded.append(current);
            continue;
        }

        const QChar escaped = value.at(++i);
        switch (escaped.unicode()) {
        case 'n': decoded.append(QLatin1Char('\n')); break;
        case 'r': decoded.append(QLatin1Char('\r')); break;
        case 't': decoded.append(QLatin1Char('\t')); break;
        case '\\': decoded.append(QLatin1Char('\\')); break;
        case '\'': decoded.append(QLatin1Char('\'')); break;
        case '"': decoded.append(QLatin1Char('"')); break;
        case 'u': {
            if (i + 4 < value.size()) {
                bool ok = false;
                const ushort codePoint = value.mid(i + 1, 4).toUShort(&ok, 16);
                if (ok) {
                    decoded.append(QChar(codePoint));
                    i += 4;
                    break;
                }
            }
            decoded.append(escaped);
            break;
        }
        case 'x': {
            if (i + 2 < value.size()) {
                bool ok = false;
                const ushort codePoint = value.mid(i + 1, 2).toUShort(&ok, 16);
                if (ok) {
                    decoded.append(QChar(codePoint));
                    i += 2;
                    break;
                }
            }
            decoded.append(escaped);
            break;
        }
        case '\n': break;
        case '\r':
            if (i + 1 < value.size() && value.at(i + 1) == QLatin1Char('\n')) ++i;
            break;
        default:
            decoded.append(escaped);
            break;
        }
    }

    return decoded;
}

QString LegacyI18nCatalog::canonicalEnglish(const QString &value) {
    QString normalized = value.normalized(QString::NormalizationForm_KC).toCaseFolded();
    normalized.replace(
        QRegularExpression(QStringLiteral("[\\p{P}\\p{S}\\s]+")),
        QStringLiteral(" ")
    );
    return normalized.trimmed();
}

QString LegacyI18nCatalog::legacyKeyCandidate(const QString &nativeKey) {
    QString result;
    result.reserve(nativeKey.size() + 8);

    for (qsizetype i = 0; i < nativeKey.size(); ++i) {
        const QChar current = nativeKey.at(i);
        if (current == QLatin1Char('.') || current == QLatin1Char('-')) {
            if (!result.isEmpty() && result.back() != QLatin1Char('_')) {
                result.append(QLatin1Char('_'));
            }
            continue;
        }

        if (current.isUpper()
            && !result.isEmpty()
            && result.back() != QLatin1Char('_')
            && i > 0
            && (nativeKey.at(i - 1).isLower() || nativeKey.at(i - 1).isDigit())) {
            result.append(QLatin1Char('_'));
        }
        result.append(current.toLower());
    }

    return result;
}
