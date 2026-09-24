#include "settings/NativeSettings.h"

#include <QHash>
#include <QSet>
#include <QStandardPaths>

namespace {
QString defaultDownloadDirectory() {
    const QString location = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
    return location;
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
}

NativeSettings::NativeSettings(QObject *parent)
    : QObject(parent),
      m_settings(QStringLiteral("NOVA"), QStringLiteral("DownloadManagerNative")) {}

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
    const QString stored = value<QString>(QStringLiteral("appearance/language"), QStringLiteral("system"))
        .trimmed()
        .toLower();
    return stored.isEmpty() ? QStringLiteral("system") : stored;
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
    QString normalized = value.trimmed().toLower();
    static const QSet<QString> allowed{
        QStringLiteral("system"),
        QStringLiteral("en"),
        QStringLiteral("ar"),
        QStringLiteral("de")
    };
    if (!allowed.contains(normalized)) {
        normalized = QStringLiteral("system");
    }
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

void NativeSettings::resetToDefaults() {
    m_settings.clear();
    m_settings.sync();
    emit settingsChanged();
}
