#include "settings/NativeSettings.h"

#include <QSet>
#include <QStandardPaths>

namespace {
QString defaultDownloadDirectory() {
    const QString location = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
    return location;
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

void NativeSettings::setDefaultSaveDirectory(const QString &value) {
    store(QStringLiteral("downloads/defaultDirectory"), value.trimmed());
}

void NativeSettings::setDefaultConnections(int value) {
    store(QStringLiteral("downloads/defaultConnections"), qBound(1, value, 64));
}

void NativeSettings::setStartImmediately(bool value) {
    store(QStringLiteral("downloads/startImmediately"), value);
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

void NativeSettings::resetToDefaults() {
    m_settings.clear();
    m_settings.sync();
    emit settingsChanged();
}
