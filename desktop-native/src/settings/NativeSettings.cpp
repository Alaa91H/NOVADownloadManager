#include "settings/NativeSettings.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMetaType>
#include <QRegularExpression>
#include <QSaveFile>
#include <QSet>
#include <QStandardPaths>

namespace {
QString defaultDownloadDirectory() {
    const QString location = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
    return location;
}

QString legacyConfigPath() {
    const QString overrideDirectory = qEnvironmentVariable("NOVA_NATIVE_DATA_DIR").trimmed();
    if (!overrideDirectory.isEmpty()) {
        return QDir(overrideDirectory).filePath(QStringLiteral("config.json"));
    }

#if defined(Q_OS_WIN)
    const QString appData = qEnvironmentVariable("APPDATA").trimmed();
    if (!appData.isEmpty()) {
        return QDir(appData).filePath(
            QStringLiteral("com.nova.downloadmanager/config.json")
        );
    }
#elif defined(Q_OS_MACOS)
    const QString home = QDir::homePath();
    if (!home.isEmpty()) {
        return QDir(home).filePath(
            QStringLiteral("Library/Application Support/com.nova.downloadmanager/config.json")
        );
    }
#else
    const QString xdgDataHome = qEnvironmentVariable("XDG_DATA_HOME").trimmed();
    if (!xdgDataHome.isEmpty()) {
        return QDir(xdgDataHome).filePath(
            QStringLiteral("com.nova.downloadmanager/config.json")
        );
    }

    const QString home = QDir::homePath();
    if (!home.isEmpty()) {
        return QDir(home).filePath(
            QStringLiteral(".local/share/com.nova.downloadmanager/config.json")
        );
    }
#endif

    return {};
}

QString nativeLanguageFromLegacy(const QString &language) {
    QString normalized = language.trimmed();
    if (normalized.isEmpty()) {
        return {};
    }
    normalized.replace(QLatin1Char('_'), QLatin1Char('-'));
    return normalized.toLower().section(QLatin1Char('-'), 0, 0)
            == QStringLiteral("ar")
        ? QStringLiteral("ar")
        : QStringLiteral("en");
}

QString canonicalDownloadColumn(const QString &value) {
    const QString key = value.trimmed().toLower();
    static const QHash<QString, QString> columns{
        {QStringLiteral("name"), QStringLiteral("name")},
        {QStringLiteral("size"), QStringLiteral("size")},
        {QStringLiteral("progress"), QStringLiteral("progress")},
        {QStringLiteral("speed"), QStringLiteral("speed")},
        {QStringLiteral("eta"), QStringLiteral("eta")},
        {QStringLiteral("elapsed"), QStringLiteral("elapsed")},
        {QStringLiteral("dateadded"), QStringLiteral("dateAdded")},
        {QStringLiteral("status"), QStringLiteral("status")},
        {QStringLiteral("retries"), QStringLiteral("retries")},
        {QStringLiteral("connections"), QStringLiteral("connections")},
        {QStringLiteral("crc32"), QStringLiteral("crc32")},
        {QStringLiteral("priority"), QStringLiteral("priority")},
        {QStringLiteral("completeddate"), QStringLiteral("completedDate")},
        {QStringLiteral("sourceurl"), QStringLiteral("sourceUrl")},
        {QStringLiteral("smartcategory"), QStringLiteral("smartCategory")}
    };
    return columns.value(key);
}

QString canonicalDownloadSortKey(const QString &value) {
    const QString column = canonicalDownloadColumn(value);
    if (!column.isEmpty()) {
        return column;
    }
    return value.trimmed().compare(QStringLiteral("engine"), Qt::CaseInsensitive) == 0
        ? QStringLiteral("engine")
        : QString();
}

QVariantMap advancedDefaults() {
    return {
        {QStringLiteral("proxyEnabled"), false},
        {QStringLiteral("proxyHost"), QString()},
        {QStringLiteral("proxyPort"), QString()},
        {QStringLiteral("proxyUser"), QString()},
        {QStringLiteral("proxyPassword"), QString()},
        {QStringLiteral("proxyType"), QStringLiteral("http")},
        {QStringLiteral("proxyTunnel"), false},
        {QStringLiteral("speedLimiterEnabled"), false},
        {QStringLiteral("speedLimitKbs"), 0},
        {QStringLiteral("timeoutSec"), 60},
        {QStringLiteral("connectTimeoutSec"), 30},
        {QStringLiteral("retryCount"), 3},
        {QStringLiteral("retryDelaySec"), 5},
        {QStringLiteral("maxRedirs"), 20},
        {QStringLiteral("ipResolve"), QString()},
        {QStringLiteral("dnsServers"), QString()},
        {QStringLiteral("dnsResolver"), QStringLiteral("system")},
        {QStringLiteral("dnsCustomResolver"), QString()},
        {QStringLiteral("dnsCacheTimeoutSec"), 300},
        {QStringLiteral("keepaliveTimeSec"), 0},
        {QStringLiteral("httpVersion"), QString()},
        {QStringLiteral("insecure"), false},
        {QStringLiteral("caCert"), QString()},
        {QStringLiteral("clientCert"), QString()},
        {QStringLiteral("clientKey"), QString()},
        {QStringLiteral("tlsMin"), QString()},
        {QStringLiteral("ciphers"), QString()},
        {QStringLiteral("userAgent"), QStringLiteral("NOVA Native")},
        {QStringLiteral("vpnEnabled"), false},
        {QStringLiteral("vpnMode"), QStringLiteral("system")},
        {QStringLiteral("vpnProxyUrl"), QString()},
        {QStringLiteral("vpnBindAddress"), QString()},
        {QStringLiteral("vpnKillSwitch"), true},
        {QStringLiteral("videoQuality"), QStringLiteral("best")},
        {QStringLiteral("downloadSubtitles"), false},
        {QStringLiteral("subtitleLanguage"), QString()},
        {QStringLiteral("ffmpegPath"), QString()},
        {QStringLiteral("ffmpegAutoMerge"), true},
        {QStringLiteral("tempFolder"), QString()},
        {QStringLiteral("duplicateAction"), QStringLiteral("rename")},
        {QStringLiteral("warnBeforeDuplicateDownload"), true},
        {QStringLiteral("openOnComplete"), false},
        {QStringLiteral("openFolderOnComplete"), false},
        {QStringLiteral("dynamicAllocation"), true},
        {QStringLiteral("bufferSizeKb"), 256},
        {QStringLiteral("loggingEnabled"), false},
        {QStringLiteral("logLevel"), QStringLiteral("info")},
        {QStringLiteral("browserInterceptKeys"), QStringLiteral("Alt")},
        {QStringLiteral("telegramEnabled"), false},
        {QStringLiteral("telegramToken"), QString()},
        {QStringLiteral("telegramChatId"), QString()},
        {QStringLiteral("telegramApiBase"), QStringLiteral("https://api.telegram.org")},
        {QStringLiteral("telegramFileUploadLimitMb"), 50}
    };
}

QVariantMap shortcutDefaults() {
    return {
        {QStringLiteral("addDownload"), QStringLiteral("Ctrl+N")},
        {QStringLiteral("batchDownload"), QStringLiteral("Ctrl+Shift+N")},
        {QStringLiteral("focusSearch"), QStringLiteral("Ctrl+F")},
        {QStringLiteral("selectAllDownloads"), QStringLiteral("Ctrl+A")},
        {QStringLiteral("resumeSelected"), QStringLiteral("Ctrl+R")},
        {QStringLiteral("resumeAll"), QStringLiteral("Ctrl+Shift+R")},
        {QStringLiteral("stopSelected"), QStringLiteral("Ctrl+S")},
        {QStringLiteral("stopAll"), QStringLiteral("Ctrl+Shift+S")},
        {QStringLiteral("deleteSelected"), QStringLiteral("Delete")},
        {QStringLiteral("deleteCompleted"), QStringLiteral("Ctrl+Shift+Delete")},
        {QStringLiteral("openSettings"), QStringLiteral("Ctrl+,")},
        {QStringLiteral("openScheduler"), QStringLiteral("Ctrl+L")},
        {QStringLiteral("toggleNotifications"), QStringLiteral("Ctrl+M")},
        {QStringLiteral("toggleSpeedLimiter"), QStringLiteral("Ctrl+Shift+L")}
    };
}

QVariant normalizedAdvancedValue(const QString &key, const QVariant &candidate) {
    const QVariantMap defaults = advancedDefaults();
    if (!defaults.contains(key)) {
        return {};
    }

    const QVariant fallback = defaults.value(key);
    if (fallback.metaType().id() == QMetaType::Bool) {
        return candidate.toBool();
    }
    if (fallback.metaType().id() == QMetaType::Int) {
        int value = candidate.toInt();
        if (key == QStringLiteral("timeoutSec")) value = qBound(1, value, 86400);
        else if (key == QStringLiteral("connectTimeoutSec")) value = qBound(1, value, 3600);
        else if (key == QStringLiteral("retryCount")) value = qBound(0, value, 9999);
        else if (key == QStringLiteral("retryDelaySec")) value = qBound(1, value, 86400);
        else if (key == QStringLiteral("maxRedirs")) value = qBound(0, value, 1000);
        else if (key == QStringLiteral("dnsCacheTimeoutSec")) value = qBound(0, value, 86400);
        else if (key == QStringLiteral("keepaliveTimeSec")) value = qBound(0, value, 86400);
        else if (key == QStringLiteral("bufferSizeKb")) value = qBound(16, value, 1024 * 1024);
        else if (key == QStringLiteral("speedLimitKbs")) value = qBound(0, value, 100000000);
        else if (key == QStringLiteral("telegramFileUploadLimitMb")) value = qBound(1, value, 2000);
        return value;
    }

    QString value = candidate.toString().trimmed();
    if (value.size() > 4096) {
        value.truncate(4096);
    }
    if (key == QStringLiteral("proxyType")) {
        static const QSet<QString> allowed{
            QStringLiteral("http"), QStringLiteral("https"), QStringLiteral("socks4"),
            QStringLiteral("socks4a"), QStringLiteral("socks5"), QStringLiteral("socks5h")
        };
        if (!allowed.contains(value.toLower())) value = QStringLiteral("http");
        else value = value.toLower();
    } else if (key == QStringLiteral("videoQuality")) {
        static const QSet<QString> allowed{
            QStringLiteral("best"), QStringLiteral("good"), QStringLiteral("worst")
        };
        if (!allowed.contains(value.toLower())) value = QStringLiteral("best");
        else value = value.toLower();
    } else if (key == QStringLiteral("logLevel")) {
        static const QSet<QString> allowed{
            QStringLiteral("off"), QStringLiteral("trace"),
            QStringLiteral("debug"), QStringLiteral("info"),
            QStringLiteral("warn"), QStringLiteral("error")
        };
        if (!allowed.contains(value.toLower())) value = QStringLiteral("info");
        else value = value.toLower();
    } else if (key == QStringLiteral("vpnMode")) {
        static const QSet<QString> allowed{
            QStringLiteral("system"), QStringLiteral("proxy"), QStringLiteral("bind")
        };
        if (!allowed.contains(value.toLower())) value = QStringLiteral("system");
        else value = value.toLower();
    }
    return value;
}
}

NativeSettings::NativeSettings(QObject *parent)
    : QObject(parent),
      m_settings(QStringLiteral("NOVA"), QStringLiteral("DownloadManagerNative")) {
    migrateLegacySettingsIfNeeded();
}

NativeSettings::NativeSettings(const QString &settingsFile, QObject *parent)
    : QObject(parent),
      m_settings(settingsFile, QSettings::IniFormat) {
    migrateLegacySettingsIfNeeded();
}

void NativeSettings::migrateLegacySettingsIfNeeded() {
    static const QString markerKey = QStringLiteral("migration/legacyUiImported");
    static const QString advancedMarkerKey =
        QStringLiteral("migration/legacyAdvancedImported");

    const bool coreImported = m_settings.value(markerKey, false).toBool();
    const bool advancedImported = m_settings.value(advancedMarkerKey, false).toBool();
    if (coreImported && advancedImported) {
        return;
    }

    const QString configPath = legacyConfigPath();
    if (configPath.isEmpty()) {
        return;
    }

    QFile file(configPath);
    if (!file.exists() || !file.open(QIODevice::ReadOnly)) {
        return;
    }

    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        return;
    }

    const QJsonObject root = document.object();
    const QJsonObject general = root.value(QStringLiteral("general")).toObject();
    const QJsonObject connection = root.value(QStringLiteral("connection")).toObject();
    const QJsonObject connectionDefaults =
        connection.value(QStringLiteral("defaults")).toObject();
    const QJsonObject saveAndCategories =
        root.value(QStringLiteral("saveAndCategories")).toObject();
    const QJsonObject extra = root.value(QStringLiteral("extra")).toObject();
    const QJsonObject advanced = root.value(QStringLiteral("advanced")).toObject();
    const QJsonObject shortcuts =
        root.value(QStringLiteral("keyboardShortcuts")).toObject();
    const QJsonObject shortcutBindings =
        shortcuts.value(QStringLiteral("bindings")).toObject();

    const auto importIfMissing = [this](const QString &key, const QVariant &value) {
        if (!value.isValid() || m_settings.contains(key)) {
            return;
        }
        m_settings.setValue(key, value);
    };

    if (!coreImported) {
        const QString defaultFolder =
            saveAndCategories.value(QStringLiteral("defaultFolder")).toString().trimmed();
        if (!defaultFolder.isEmpty()) {
            importIfMissing(
                QStringLiteral("downloads/defaultDirectory"),
                defaultFolder
            );
        }

        if (general.value(QStringLiteral("monitorClipboard")).isBool()) {
            importIfMissing(
                QStringLiteral("downloads/monitorClipboard"),
                general.value(QStringLiteral("monitorClipboard")).toBool()
            );
        }

        const int maxConnections =
            connection.value(QStringLiteral("maxConnections")).toInt(0);
        if (maxConnections > 0) {
            importIfMissing(
                QStringLiteral("downloads/defaultConnections"),
                qBound(1, maxConnections, 64)
            );
        }

        const QString language = nativeLanguageFromLegacy(
            extra.value(QStringLiteral("language")).toString()
        );
        if (!language.isEmpty()) {
            importIfMissing(QStringLiteral("appearance/language"), language);
        }
    }

    if (!advancedImported) {
        const QVariantMap defaults = advancedDefaults();
        const auto importAdvanced =
            [&](const QString &nativeKey, const QJsonValue &legacyValue) {
                if (legacyValue.isUndefined() || legacyValue.isNull()) {
                    return;
                }
                const QVariant normalized =
                    normalizedAdvancedValue(nativeKey, legacyValue.toVariant());
                if (normalized.isValid()) {
                    importIfMissing(
                        QStringLiteral("advanced/") + nativeKey,
                        normalized
                    );
                }
            };

        importAdvanced(
            QStringLiteral("proxyEnabled"),
            connection.value(QStringLiteral("enableProxy"))
        );
        importAdvanced(
            QStringLiteral("proxyHost"),
            connection.value(QStringLiteral("proxyHost"))
        );
        importAdvanced(
            QStringLiteral("proxyPort"),
            connection.value(QStringLiteral("proxyPort"))
        );
        importAdvanced(
            QStringLiteral("proxyUser"),
            connection.value(QStringLiteral("proxyUser"))
        );
        importAdvanced(
            QStringLiteral("proxyPassword"),
            connection.value(QStringLiteral("proxyPass"))
        );
        importAdvanced(
            QStringLiteral("proxyType"),
            connection.value(QStringLiteral("proxyType"))
        );
        importAdvanced(
            QStringLiteral("proxyTunnel"),
            connection.value(QStringLiteral("proxyTunnel"))
        );

        const QJsonObject speedLimiter =
            connection.value(QStringLiteral("speedLimiter")).toObject();
        importAdvanced(
            QStringLiteral("speedLimiterEnabled"),
            speedLimiter.value(QStringLiteral("enabled"))
        );
        importAdvanced(
            QStringLiteral("speedLimitKbs"),
            speedLimiter.value(QStringLiteral("maxSpeedKbs"))
        );

        for (auto it = connectionDefaults.begin();
             it != connectionDefaults.end();
             ++it) {
            if (defaults.contains(it.key())) {
                importAdvanced(it.key(), it.value());
            }
        }

        const QStringList extraKeys{
            QStringLiteral("dnsResolver"),
            QStringLiteral("dnsCustomResolver"),
            QStringLiteral("dnsCacheTimeoutSec"),
            QStringLiteral("userAgent"),
            QStringLiteral("vpnEnabled"),
            QStringLiteral("vpnMode"),
            QStringLiteral("vpnProxyUrl"),
            QStringLiteral("vpnBindAddress"),
            QStringLiteral("vpnKillSwitch"),
            QStringLiteral("videoQuality"),
            QStringLiteral("downloadSubtitles"),
            QStringLiteral("subtitleLanguage"),
            QStringLiteral("ffmpegPath"),
            QStringLiteral("ffmpegAutoMerge"),
            QStringLiteral("duplicateAction"),
            QStringLiteral("warnBeforeDuplicateDownload"),
            QStringLiteral("openOnComplete"),
            QStringLiteral("openFolderOnComplete")
        };
        for (const QString &key : extraKeys) {
            importAdvanced(key, extra.value(key));
        }

        importAdvanced(
            QStringLiteral("telegramEnabled"),
            extra.value(QStringLiteral("tgEnabled"))
        );
        importAdvanced(
            QStringLiteral("telegramToken"),
            extra.value(QStringLiteral("tgBotToken"))
        );
        importAdvanced(
            QStringLiteral("telegramChatId"),
            extra.value(QStringLiteral("tgChatId"))
        );
        importAdvanced(
            QStringLiteral("telegramApiBase"),
            extra.value(QStringLiteral("tgApiBase"))
        );
        importAdvanced(
            QStringLiteral("telegramFileUploadLimitMb"),
            extra.value(QStringLiteral("tgFileUploadLimitMb"))
        );

        importAdvanced(
            QStringLiteral("tempFolder"),
            saveAndCategories.value(QStringLiteral("tempFolder"))
        );

        const QStringList advancedKeys{
            QStringLiteral("dynamicAllocation"),
            QStringLiteral("bufferSizeKb"),
            QStringLiteral("loggingEnabled"),
            QStringLiteral("logLevel"),
            QStringLiteral("browserInterceptKeys")
        };
        for (const QString &key : advancedKeys) {
            importAdvanced(key, advanced.value(key));
        }

        if (shortcuts.value(QStringLiteral("enabled")).isBool()) {
            importIfMissing(
                QStringLiteral("shortcuts/enabled"),
                shortcuts.value(QStringLiteral("enabled")).toBool()
            );
        }
        const QVariantMap shortcutDefaultValues = shortcutDefaults();
        for (auto it = shortcutBindings.begin();
             it != shortcutBindings.end();
             ++it) {
            if (shortcutDefaultValues.contains(it.key()) && it.value().isString()) {
                const QString sequence = it.value().toString().trimmed();
                if (!sequence.isEmpty() && sequence.size() <= 128) {
                    importIfMissing(
                        QStringLiteral("shortcuts/") + it.key(),
                        sequence
                    );
                }
            }
        }

        m_settings.setValue(advancedMarkerKey, true);
    }

    m_settings.setValue(markerKey, true);
    m_settings.setValue(
        QStringLiteral("migration/legacyUiSource"),
        QFileInfo(configPath).absoluteFilePath()
    );
    m_settings.sync();
}

QString NativeSettings::defaultSaveDirectory() const {
    return value<QString>(QStringLiteral("downloads/defaultDirectory"), defaultDownloadDirectory());
}

int NativeSettings::defaultConnections() const {
    return value<int>(QStringLiteral("downloads/defaultConnections"), 8);
}

bool NativeSettings::startImmediately() const {
    return value<bool>(QStringLiteral("downloads/startImmediately"), true);
}

bool NativeSettings::monitorClipboard() const {
    return value<bool>(QStringLiteral("downloads/monitorClipboard"), false);
}

bool NativeSettings::closeToTray() const {
    return value<bool>(QStringLiteral("desktop/closeToTray"), true);
}

bool NativeSettings::startMinimized() const {
    return value<bool>(QStringLiteral("desktop/startMinimized"), false);
}

bool NativeSettings::notificationsEnabled() const {
    return value<bool>(QStringLiteral("notifications/enabled"), true);
}

bool NativeSettings::notifyOnComplete() const {
    return value<bool>(QStringLiteral("notifications/onComplete"), true);
}

bool NativeSettings::notifyOnFailure() const {
    return value<bool>(QStringLiteral("notifications/onFailure"), true);
}

QString NativeSettings::updateChannel() const {
    const QString stored = value<QString>(QStringLiteral("updates/channel"), QStringLiteral("stable"))
        .trimmed()
        .toLower();
    return stored == QStringLiteral("preview")
        ? QStringLiteral("preview")
        : QStringLiteral("stable");
}

QString NativeSettings::uiLanguage() const {
    const QString stored = value<QString>(
        QStringLiteral("appearance/language"),
        QStringLiteral("en")
    ).trimmed().toLower();

    return stored == QStringLiteral("ar")
        ? QStringLiteral("ar")
        : QStringLiteral("en");
}

QString NativeSettings::appearanceMode() const {
    const QString stored = value<QString>(QStringLiteral("appearance/mode"), QStringLiteral("system"))
        .trimmed()
        .toLower();
    if (stored == QStringLiteral("light") || stored == QStringLiteral("dark")) {
        return stored;
    }
    return QStringLiteral("system");
}

bool NativeSettings::highContrast() const {
    return value<bool>(QStringLiteral("appearance/highContrast"), false);
}

bool NativeSettings::reducedMotion() const {
    return value<bool>(QStringLiteral("appearance/reducedMotion"), false);
}

double NativeSettings::fontScale() const {
    return qBound(0.85, value<double>(QStringLiteral("appearance/fontScale"), 1.0), 1.35);
}

bool NativeSettings::sidebarVisible() const {
    return value<bool>(QStringLiteral("layout/sidebarVisible"), true);
}

bool NativeSettings::sidebarCollapsed() const {
    return value<bool>(QStringLiteral("layout/sidebarCollapsed"), true);
}

bool NativeSettings::detailsPanelVisible() const {
    return value<bool>(QStringLiteral("layout/detailsPanelVisible"), true);
}

bool NativeSettings::statusBarVisible() const {
    return value<bool>(QStringLiteral("layout/statusBarVisible"), true);
}

QString NativeSettings::interfaceDensity() const {
    const QString stored = value<QString>(
        QStringLiteral("layout/density"),
        QStringLiteral("comfortable")
    ).trimmed().toLower();
    if (stored == QStringLiteral("compact") || stored == QStringLiteral("dense")) {
        return stored;
    }
    return QStringLiteral("comfortable");
}

QString NativeSettings::accentColor() const {
    const QString stored = value<QString>(
        QStringLiteral("appearance/accentColor"),
        QStringLiteral("#168df7")
    ).trimmed().toLower();
    static const QSet<QString> allowed{
        QStringLiteral("#168df7"),
        QStringLiteral("#7c5cff"),
        QStringLiteral("#e93d82"),
        QStringLiteral("#dc2626"),
        QStringLiteral("#c86700"),
        QStringLiteral("#168a4a")
    };
    return allowed.contains(stored) ? stored : QStringLiteral("#168df7");
}

int NativeSettings::cornerRadius() const {
    return qBound(4, value<int>(QStringLiteral("appearance/cornerRadius"), 10), 18);
}

QStringList NativeSettings::downloadColumns() const {
    const QStringList fallback{
        QStringLiteral("name"),
        QStringLiteral("size"),
        QStringLiteral("progress"),
        QStringLiteral("speed"),
        QStringLiteral("eta"),
        QStringLiteral("status")
    };
    const QStringList stored = value<QStringList>(
        QStringLiteral("downloads/columns"),
        fallback
    );

    static const QSet<QString> allowed{
        QStringLiteral("name"),
        QStringLiteral("size"),
        QStringLiteral("progress"),
        QStringLiteral("speed"),
        QStringLiteral("eta"),
        QStringLiteral("elapsed"),
        QStringLiteral("dateAdded"),
        QStringLiteral("status"),
        QStringLiteral("retries"),
        QStringLiteral("connections"),
        QStringLiteral("crc32"),
        QStringLiteral("priority"),
        QStringLiteral("completedDate"),
        QStringLiteral("sourceUrl"),
        QStringLiteral("smartCategory")
    };

    QStringList result{QStringLiteral("name")};
    for (const QString &column : stored) {
        const QString normalized = canonicalDownloadColumn(column);
        if (normalized != QStringLiteral("name")
            && allowed.contains(normalized)
            && !result.contains(normalized)) {
            result.append(normalized);
        }
    }
    return result;
}

QString NativeSettings::downloadSortKey() const {
    const QString stored = value<QString>(
        QStringLiteral("downloads/sortKey"),
        QStringLiteral("dateAdded")
    ).trimmed();

    static const QSet<QString> allowed{
        QStringLiteral("name"),
        QStringLiteral("size"),
        QStringLiteral("progress"),
        QStringLiteral("speed"),
        QStringLiteral("eta"),
        QStringLiteral("elapsed"),
        QStringLiteral("status"),
        QStringLiteral("dateAdded"),
        QStringLiteral("engine"),
        QStringLiteral("retries"),
        QStringLiteral("connections"),
        QStringLiteral("crc32"),
        QStringLiteral("priority"),
        QStringLiteral("completedDate"),
        QStringLiteral("sourceUrl"),
        QStringLiteral("smartCategory")
    };
    const QString canonical = canonicalDownloadSortKey(stored);
    return allowed.contains(canonical) ? canonical : QStringLiteral("dateAdded");
}

bool NativeSettings::downloadSortAscending() const {
    return value<bool>(QStringLiteral("downloads/sortAscending"), false);
}

QVariantMap NativeSettings::advancedSettings() const {
    QVariantMap result = advancedDefaults();
    for (auto it = result.begin(); it != result.end(); ++it) {
        it.value() = m_settings.value(QStringLiteral("advanced/") + it.key(), it.value());
    }
    return result;
}

QVariantMap NativeSettings::shortcutBindings() const {
    QVariantMap result = shortcutDefaults();
    for (auto it = result.begin(); it != result.end(); ++it) {
        const QString value = m_settings
            .value(QStringLiteral("shortcuts/") + it.key(), it.value())
            .toString()
            .trimmed();
        if (!value.isEmpty()) {
            it.value() = value;
        }
    }
    return result;
}

bool NativeSettings::shortcutsEnabled() const {
    return value<bool>(QStringLiteral("shortcuts/enabled"), true);
}

void NativeSettings::setAdvancedValue(const QString &key, const QVariant &candidate) {
    const QVariant normalized = normalizedAdvancedValue(key, candidate);
    if (!normalized.isValid()) {
        return;
    }
    store(QStringLiteral("advanced/") + key, normalized);
}

void NativeSettings::setShortcutBinding(const QString &action, const QString &sequence) {
    const QVariantMap defaults = shortcutDefaults();
    if (!defaults.contains(action)) {
        return;
    }
    QString normalized = sequence.trimmed();
    if (normalized.isEmpty() || normalized.size() > 128) {
        normalized = defaults.value(action).toString();
    }
    store(QStringLiteral("shortcuts/") + action, normalized);
}

void NativeSettings::setShortcutsEnabled(bool enabled) {
    store(QStringLiteral("shortcuts/enabled"), enabled);
}

bool NativeSettings::exportBackup(const QString &path) const {
    const QString target = path.trimmed();
    if (target.isEmpty()) {
        return false;
    }

    QVariantMap advanced = advancedSettings();
    advanced.remove(QStringLiteral("proxyPassword"));
    advanced.remove(QStringLiteral("telegramToken"));

    QJsonObject settings;
    settings.insert(QStringLiteral("defaultSaveDirectory"), defaultSaveDirectory());
    settings.insert(QStringLiteral("defaultConnections"), defaultConnections());
    settings.insert(QStringLiteral("startImmediately"), startImmediately());
    settings.insert(QStringLiteral("monitorClipboard"), monitorClipboard());
    settings.insert(QStringLiteral("closeToTray"), closeToTray());
    settings.insert(QStringLiteral("startMinimized"), startMinimized());
    settings.insert(QStringLiteral("notificationsEnabled"), notificationsEnabled());
    settings.insert(QStringLiteral("notifyOnComplete"), notifyOnComplete());
    settings.insert(QStringLiteral("notifyOnFailure"), notifyOnFailure());
    settings.insert(QStringLiteral("updateChannel"), updateChannel());
    settings.insert(QStringLiteral("uiLanguage"), uiLanguage());
    settings.insert(QStringLiteral("appearanceMode"), appearanceMode());
    settings.insert(QStringLiteral("highContrast"), highContrast());
    settings.insert(QStringLiteral("reducedMotion"), reducedMotion());
    settings.insert(QStringLiteral("fontScale"), fontScale());
    settings.insert(QStringLiteral("sidebarVisible"), sidebarVisible());
    settings.insert(QStringLiteral("sidebarCollapsed"), sidebarCollapsed());
    settings.insert(QStringLiteral("detailsPanelVisible"), detailsPanelVisible());
    settings.insert(QStringLiteral("statusBarVisible"), statusBarVisible());
    settings.insert(QStringLiteral("interfaceDensity"), interfaceDensity());
    settings.insert(QStringLiteral("accentColor"), accentColor());
    settings.insert(QStringLiteral("cornerRadius"), cornerRadius());
    settings.insert(
        QStringLiteral("downloadColumns"),
        QJsonArray::fromStringList(downloadColumns())
    );
    settings.insert(QStringLiteral("downloadSortKey"), downloadSortKey());
    settings.insert(QStringLiteral("downloadSortAscending"), downloadSortAscending());
    settings.insert(QStringLiteral("advanced"), QJsonObject::fromVariantMap(advanced));
    settings.insert(
        QStringLiteral("shortcutBindings"),
        QJsonObject::fromVariantMap(shortcutBindings())
    );
    settings.insert(QStringLiteral("shortcutsEnabled"), shortcutsEnabled());

    QJsonObject root;
    root.insert(QStringLiteral("schema"), QStringLiteral("nova-native-settings-v1"));
    root.insert(QStringLiteral("settings"), settings);

    QSaveFile file(target);
    if (!file.open(QIODevice::WriteOnly)) {
        return false;
    }
    const QByteArray payload = QJsonDocument(root).toJson(QJsonDocument::Indented);
    if (file.write(payload) != payload.size()) {
        file.cancelWriting();
        return false;
    }
    return file.commit();
}

bool NativeSettings::importBackup(const QString &path) {
    QFile file(path.trimmed());
    if (!file.exists() || file.size() > 1024 * 1024 || !file.open(QIODevice::ReadOnly)) {
        return false;
    }
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) {
        return false;
    }

    const QJsonObject root = document.object();
    if (root.value(QStringLiteral("schema")).toString()
        != QStringLiteral("nova-native-settings-v1")) {
        return false;
    }
    const QJsonObject settings = root.value(QStringLiteral("settings")).toObject();
    if (settings.isEmpty()) {
        return false;
    }

    if (settings.value(QStringLiteral("defaultSaveDirectory")).isString()) {
        setDefaultSaveDirectory(
            settings.value(QStringLiteral("defaultSaveDirectory")).toString()
        );
    }
    if (settings.value(QStringLiteral("defaultConnections")).isDouble()) {
        setDefaultConnections(
            settings.value(QStringLiteral("defaultConnections")).toInt()
        );
    }
    if (settings.value(QStringLiteral("startImmediately")).isBool()) {
        setStartImmediately(settings.value(QStringLiteral("startImmediately")).toBool());
    }
    if (settings.value(QStringLiteral("monitorClipboard")).isBool()) {
        setMonitorClipboard(settings.value(QStringLiteral("monitorClipboard")).toBool());
    }
    if (settings.value(QStringLiteral("closeToTray")).isBool()) {
        setCloseToTray(settings.value(QStringLiteral("closeToTray")).toBool());
    }
    if (settings.value(QStringLiteral("startMinimized")).isBool()) {
        setStartMinimized(settings.value(QStringLiteral("startMinimized")).toBool());
    }
    if (settings.value(QStringLiteral("notificationsEnabled")).isBool()) {
        setNotificationsEnabled(
            settings.value(QStringLiteral("notificationsEnabled")).toBool()
        );
    }
    if (settings.value(QStringLiteral("notifyOnComplete")).isBool()) {
        setNotifyOnComplete(settings.value(QStringLiteral("notifyOnComplete")).toBool());
    }
    if (settings.value(QStringLiteral("notifyOnFailure")).isBool()) {
        setNotifyOnFailure(settings.value(QStringLiteral("notifyOnFailure")).toBool());
    }
    if (settings.value(QStringLiteral("updateChannel")).isString()) {
        setUpdateChannel(settings.value(QStringLiteral("updateChannel")).toString());
    }
    if (settings.value(QStringLiteral("uiLanguage")).isString()) {
        setUiLanguage(settings.value(QStringLiteral("uiLanguage")).toString());
    }
    if (settings.value(QStringLiteral("appearanceMode")).isString()) {
        setAppearanceMode(settings.value(QStringLiteral("appearanceMode")).toString());
    }
    if (settings.value(QStringLiteral("highContrast")).isBool()) {
        setHighContrast(settings.value(QStringLiteral("highContrast")).toBool());
    }
    if (settings.value(QStringLiteral("reducedMotion")).isBool()) {
        setReducedMotion(settings.value(QStringLiteral("reducedMotion")).toBool());
    }
    if (settings.value(QStringLiteral("fontScale")).isDouble()) {
        setFontScale(settings.value(QStringLiteral("fontScale")).toDouble());
    }
    if (settings.value(QStringLiteral("sidebarVisible")).isBool()) {
        setSidebarVisible(settings.value(QStringLiteral("sidebarVisible")).toBool());
    }
    if (settings.value(QStringLiteral("sidebarCollapsed")).isBool()) {
        setSidebarCollapsed(settings.value(QStringLiteral("sidebarCollapsed")).toBool());
    }
    if (settings.value(QStringLiteral("detailsPanelVisible")).isBool()) {
        setDetailsPanelVisible(settings.value(QStringLiteral("detailsPanelVisible")).toBool());
    }
    if (settings.value(QStringLiteral("statusBarVisible")).isBool()) {
        setStatusBarVisible(settings.value(QStringLiteral("statusBarVisible")).toBool());
    }
    if (settings.value(QStringLiteral("interfaceDensity")).isString()) {
        setInterfaceDensity(settings.value(QStringLiteral("interfaceDensity")).toString());
    }
    if (settings.value(QStringLiteral("accentColor")).isString()) {
        setAccentColor(settings.value(QStringLiteral("accentColor")).toString());
    }
    if (settings.value(QStringLiteral("cornerRadius")).isDouble()) {
        setCornerRadius(settings.value(QStringLiteral("cornerRadius")).toInt());
    }
    if (settings.value(QStringLiteral("downloadColumns")).isArray()) {
        QStringList columns;
        for (const QJsonValue &value :
             settings.value(QStringLiteral("downloadColumns")).toArray()) {
            if (value.isString()) {
                columns.append(value.toString());
            }
        }
        setDownloadColumns(columns);
    }
    if (settings.value(QStringLiteral("downloadSortKey")).isString()) {
        setDownloadSortKey(
            settings.value(QStringLiteral("downloadSortKey")).toString()
        );
    }
    if (settings.value(QStringLiteral("downloadSortAscending")).isBool()) {
        setDownloadSortAscending(
            settings.value(QStringLiteral("downloadSortAscending")).toBool()
        );
    }

    const QJsonObject advanced = settings.value(QStringLiteral("advanced")).toObject();
    for (auto it = advanced.begin(); it != advanced.end(); ++it) {
        const QVariant normalized = normalizedAdvancedValue(it.key(), it.value().toVariant());
        if (normalized.isValid()
            && it.key() != QStringLiteral("proxyPassword")
            && it.key() != QStringLiteral("telegramToken")) {
            m_settings.setValue(QStringLiteral("advanced/") + it.key(), normalized);
        }
    }

    const QJsonObject bindings = settings.value(QStringLiteral("shortcutBindings")).toObject();
    const QVariantMap defaults = shortcutDefaults();
    for (auto it = bindings.begin(); it != bindings.end(); ++it) {
        if (defaults.contains(it.key()) && it.value().isString()) {
            const QString sequence = it.value().toString().trimmed();
            if (!sequence.isEmpty() && sequence.size() <= 128) {
                m_settings.setValue(QStringLiteral("shortcuts/") + it.key(), sequence);
            }
        }
    }
    if (settings.value(QStringLiteral("shortcutsEnabled")).isBool()) {
        m_settings.setValue(
            QStringLiteral("shortcuts/enabled"),
            settings.value(QStringLiteral("shortcutsEnabled")).toBool()
        );
    }

    m_settings.sync();
    emit settingsChanged();
    return true;
}

void NativeSettings::setDefaultSaveDirectory(const QString &value) {
    store(QStringLiteral("downloads/defaultDirectory"), value.trimmed());
}

void NativeSettings::setDefaultConnections(int value) {
    store(QStringLiteral("downloads/defaultConnections"), qBound(1, value, 64));
}

void NativeSettings::setStartImmediately(bool value) {
    store(QStringLiteral("downloads/startImmediately"), value);
}

void NativeSettings::setMonitorClipboard(bool value) {
    store(QStringLiteral("downloads/monitorClipboard"), value);
}

void NativeSettings::setCloseToTray(bool value) {
    store(QStringLiteral("desktop/closeToTray"), value);
}

void NativeSettings::setStartMinimized(bool value) {
    store(QStringLiteral("desktop/startMinimized"), value);
}

void NativeSettings::setNotificationsEnabled(bool value) {
    store(QStringLiteral("notifications/enabled"), value);
}

void NativeSettings::setNotifyOnComplete(bool value) {
    store(QStringLiteral("notifications/onComplete"), value);
}

void NativeSettings::setNotifyOnFailure(bool value) {
    store(QStringLiteral("notifications/onFailure"), value);
}

void NativeSettings::setUpdateChannel(const QString &value) {
    const QString normalized = value.trimmed().toLower() == QStringLiteral("preview")
        ? QStringLiteral("preview")
        : QStringLiteral("stable");
    store(QStringLiteral("updates/channel"), normalized);
}

void NativeSettings::setUiLanguage(const QString &value) {
    QString candidate = value.trimmed().toLower();
    candidate.replace(QLatin1Char('_'), QLatin1Char('-'));
    const QString primary = candidate.section(QLatin1Char('-'), 0, 0);
    const QString normalized = primary == QStringLiteral("ar")
        ? QStringLiteral("ar")
        : QStringLiteral("en");
    store(QStringLiteral("appearance/language"), normalized);
}

void NativeSettings::setAppearanceMode(const QString &value) {
    QString normalized = value.trimmed().toLower();
    if (normalized != QStringLiteral("light") && normalized != QStringLiteral("dark")) {
        normalized = QStringLiteral("system");
    }
    store(QStringLiteral("appearance/mode"), normalized);
}

void NativeSettings::setHighContrast(bool value) {
    store(QStringLiteral("appearance/highContrast"), value);
}

void NativeSettings::setReducedMotion(bool value) {
    store(QStringLiteral("appearance/reducedMotion"), value);
}

void NativeSettings::setFontScale(double value) {
    store(QStringLiteral("appearance/fontScale"), qBound(0.85, value, 1.35));
}

void NativeSettings::setSidebarVisible(bool value) {
    store(QStringLiteral("layout/sidebarVisible"), value);
}

void NativeSettings::setSidebarCollapsed(bool value) {
    store(QStringLiteral("layout/sidebarCollapsed"), value);
}

void NativeSettings::setDetailsPanelVisible(bool value) {
    store(QStringLiteral("layout/detailsPanelVisible"), value);
}

void NativeSettings::setStatusBarVisible(bool value) {
    store(QStringLiteral("layout/statusBarVisible"), value);
}

void NativeSettings::setInterfaceDensity(const QString &value) {
    const QString normalized = value.trimmed().toLower();
    if (normalized == QStringLiteral("compact")
        || normalized == QStringLiteral("dense")) {
        store(QStringLiteral("layout/density"), normalized);
        return;
    }
    store(QStringLiteral("layout/density"), QStringLiteral("comfortable"));
}

void NativeSettings::setAccentColor(const QString &value) {
    const QString normalized = value.trimmed().toLower();
    static const QSet<QString> allowed{
        QStringLiteral("#168df7"),
        QStringLiteral("#7c5cff"),
        QStringLiteral("#e93d82"),
        QStringLiteral("#dc2626"),
        QStringLiteral("#c86700"),
        QStringLiteral("#168a4a")
    };
    store(
        QStringLiteral("appearance/accentColor"),
        allowed.contains(normalized)
            ? normalized
            : QStringLiteral("#168df7")
    );
}

void NativeSettings::setCornerRadius(int value) {
    store(QStringLiteral("appearance/cornerRadius"), qBound(4, value, 18));
}

void NativeSettings::setDownloadColumns(const QStringList &value) {
    static const QStringList defaults{
        QStringLiteral("name"),
        QStringLiteral("size"),
        QStringLiteral("progress"),
        QStringLiteral("speed"),
        QStringLiteral("eta"),
        QStringLiteral("status")
    };
    static const QSet<QString> allowed{
        QStringLiteral("name"),
        QStringLiteral("size"),
        QStringLiteral("progress"),
        QStringLiteral("speed"),
        QStringLiteral("eta"),
        QStringLiteral("elapsed"),
        QStringLiteral("dateAdded"),
        QStringLiteral("status"),
        QStringLiteral("retries"),
        QStringLiteral("connections"),
        QStringLiteral("crc32"),
        QStringLiteral("priority"),
        QStringLiteral("completedDate"),
        QStringLiteral("sourceUrl"),
        QStringLiteral("smartCategory")
    };

    QStringList normalized{QStringLiteral("name")};
    for (const QString &column : value) {
        const QString key = canonicalDownloadColumn(column);
        if (key != QStringLiteral("name")
            && allowed.contains(key)
            && !normalized.contains(key)) {
            normalized.append(key);
        }
    }
    store(QStringLiteral("downloads/columns"), normalized);
}

void NativeSettings::setDownloadSortKey(const QString &value) {
    static const QSet<QString> allowed{
        QStringLiteral("name"),
        QStringLiteral("size"),
        QStringLiteral("progress"),
        QStringLiteral("speed"),
        QStringLiteral("eta"),
        QStringLiteral("elapsed"),
        QStringLiteral("status"),
        QStringLiteral("dateAdded"),
        QStringLiteral("engine"),
        QStringLiteral("retries"),
        QStringLiteral("connections"),
        QStringLiteral("crc32"),
        QStringLiteral("priority"),
        QStringLiteral("completedDate"),
        QStringLiteral("sourceUrl"),
        QStringLiteral("smartCategory")
    };
    const QString normalized = canonicalDownloadSortKey(value);
    store(
        QStringLiteral("downloads/sortKey"),
        allowed.contains(normalized) ? normalized : QStringLiteral("dateAdded")
    );
}

void NativeSettings::setDownloadSortAscending(bool value) {
    store(QStringLiteral("downloads/sortAscending"), value);
}

bool NativeSettings::daemonMigrationPending(const QString &area) const {
    const QString normalized = area.trimmed().toLower();
    if (normalized != QStringLiteral("telegram")
        && normalized != QStringLiteral("external-tools")) {
        return false;
    }
    return !m_settings.value(
        QStringLiteral("migration/daemon/") + normalized,
        false
    ).toBool();
}

void NativeSettings::completeDaemonMigration(const QString &area) {
    const QString normalized = area.trimmed().toLower();
    if (normalized != QStringLiteral("telegram")
        && normalized != QStringLiteral("external-tools")) {
        return;
    }
    m_settings.setValue(
        QStringLiteral("migration/daemon/") + normalized,
        true
    );
    if (normalized == QStringLiteral("telegram")) {
        m_settings.remove(QStringLiteral("advanced/telegramToken"));
    }
    m_settings.sync();
    emit settingsChanged();
}

void NativeSettings::resetToDefaults() {
    const bool legacyImported = m_settings.value(
        QStringLiteral("migration/legacyUiImported"),
        false
    ).toBool();
    const QString legacySource = m_settings.value(
        QStringLiteral("migration/legacyUiSource")
    ).toString();
    const bool advancedImported = m_settings.value(
        QStringLiteral("migration/legacyAdvancedImported"),
        false
    ).toBool();

    m_settings.clear();

    if (legacyImported) {
        m_settings.setValue(
            QStringLiteral("migration/legacyUiImported"),
            true
        );
        if (advancedImported) {
            m_settings.setValue(
                QStringLiteral("migration/legacyAdvancedImported"),
                true
            );
        }
        if (!legacySource.isEmpty()) {
            m_settings.setValue(
                QStringLiteral("migration/legacyUiSource"),
                legacySource
            );
        }
    }

    m_settings.sync();
    emit settingsChanged();
}
