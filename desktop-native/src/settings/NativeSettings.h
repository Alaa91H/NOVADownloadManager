#pragma once

#include <QObject>
#include <QSettings>
#include <QString>
#include <QVariant>

class NativeSettings final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString defaultSaveDirectory READ defaultSaveDirectory WRITE setDefaultSaveDirectory NOTIFY settingsChanged)
    Q_PROPERTY(int defaultConnections READ defaultConnections WRITE setDefaultConnections NOTIFY settingsChanged)
    Q_PROPERTY(bool startImmediately READ startImmediately WRITE setStartImmediately NOTIFY settingsChanged)
    Q_PROPERTY(bool closeToTray READ closeToTray WRITE setCloseToTray NOTIFY settingsChanged)
    Q_PROPERTY(bool startMinimized READ startMinimized WRITE setStartMinimized NOTIFY settingsChanged)
    Q_PROPERTY(bool notificationsEnabled READ notificationsEnabled WRITE setNotificationsEnabled NOTIFY settingsChanged)
    Q_PROPERTY(bool notifyOnComplete READ notifyOnComplete WRITE setNotifyOnComplete NOTIFY settingsChanged)
    Q_PROPERTY(bool notifyOnFailure READ notifyOnFailure WRITE setNotifyOnFailure NOTIFY settingsChanged)
    Q_PROPERTY(QString updateChannel READ updateChannel WRITE setUpdateChannel NOTIFY settingsChanged)

public:
    explicit NativeSettings(QObject *parent = nullptr);

    QString defaultSaveDirectory() const;
    int defaultConnections() const;
    bool startImmediately() const;
    bool closeToTray() const;
    bool startMinimized() const;
    bool notificationsEnabled() const;
    bool notifyOnComplete() const;
    bool notifyOnFailure() const;
    QString updateChannel() const;

    void setDefaultSaveDirectory(const QString &value);
    void setDefaultConnections(int value);
    void setStartImmediately(bool value);
    void setCloseToTray(bool value);
    void setStartMinimized(bool value);
    void setNotificationsEnabled(bool value);
    void setNotifyOnComplete(bool value);
    void setNotifyOnFailure(bool value);
    void setUpdateChannel(const QString &value);

    Q_INVOKABLE void resetToDefaults();

signals:
    void settingsChanged();

private:
    template <typename T>
    T value(const QString &key, const T &fallback) const {
        return m_settings.value(key, QVariant::fromValue(fallback)).template value<T>();
    }

    template <typename T>
    void store(const QString &key, const T &value) {
        if (m_settings.value(key) == QVariant::fromValue(value)) {
            return;
        }
        m_settings.setValue(key, QVariant::fromValue(value));
        m_settings.sync();
        emit settingsChanged();
    }

    QSettings m_settings;
};
