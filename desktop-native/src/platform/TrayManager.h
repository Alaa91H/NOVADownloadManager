#pragma once

#include <QHash>
#include <QJsonArray>
#include <QObject>
#include <QSystemTrayIcon>

class QAction;
class QMenu;

class TrayManager final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool available READ available CONSTANT)
    Q_PROPERTY(bool enabled READ enabled WRITE setEnabled NOTIFY enabledChanged)

public:
    explicit TrayManager(QObject *parent = nullptr);
    ~TrayManager() override;

    bool available() const noexcept;
    bool enabled() const noexcept { return m_enabled; }

    void setEnabled(bool enabled);
    void setNotificationsEnabled(bool enabled) noexcept { m_notificationsEnabled = enabled; }
    void setNotifyOnComplete(bool enabled) noexcept { m_notifyOnComplete = enabled; }
    void setNotifyOnFailure(bool enabled) noexcept { m_notifyOnFailure = enabled; }

    Q_INVOKABLE void showNotification(const QString &title, const QString &message);
    Q_INVOKABLE void handleDownloads(const QJsonArray &downloads);

signals:
    void enabledChanged();
    void showRequested();
    void quitRequested();

private:
    QSystemTrayIcon *m_tray{nullptr};
    QMenu *m_menu{nullptr};
    bool m_enabled{false};
    bool m_notificationsEnabled{true};
    bool m_notifyOnComplete{true};
    bool m_notifyOnFailure{true};
    bool m_initializedStatuses{false};
    QHash<QString, QString> m_statusByTask;
};
