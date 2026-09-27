#pragma once

#include <QNetworkAccessManager>
#include <QObject>
#include <QString>
#include <QUrl>

class UpdaterManager final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool busy READ busy NOTIFY stateChanged)
    Q_PROPERTY(QString currentVersion READ currentVersion CONSTANT)
    Q_PROPERTY(QString latestVersion READ latestVersion NOTIFY stateChanged)
    Q_PROPERTY(QString statusText READ statusText NOTIFY stateChanged)
    Q_PROPERTY(bool updateAvailable READ updateAvailable NOTIFY stateChanged)
    Q_PROPERTY(QString releaseUrl READ releaseUrl NOTIFY stateChanged)
    Q_PROPERTY(bool automaticInstallAvailable READ automaticInstallAvailable CONSTANT)
    Q_PROPERTY(QString automaticInstallStatus READ automaticInstallStatus CONSTANT)

public:
    explicit UpdaterManager(QObject *parent = nullptr);

    bool busy() const noexcept { return m_busy; }
    QString currentVersion() const;
    QString latestVersion() const { return m_latestVersion; }
    QString statusText() const { return m_statusText; }
    bool updateAvailable() const noexcept { return m_updateAvailable; }
    QString releaseUrl() const { return m_releaseUrl.toString(); }

    bool automaticInstallAvailable() const noexcept { return false; }
    QString automaticInstallStatus() const {
        return QStringLiteral(
            "Automatic installation is disabled until NOVA has a production "
            "signed updater endpoint and public verification key."
        );
    }

    Q_INVOKABLE void checkForUpdates(const QString &channel = QStringLiteral("stable"));
    Q_INVOKABLE bool openReleasePage();

signals:
    void stateChanged();
    void updateCheckFailed(const QString &message);

private:
    static QString normalizeVersion(const QString &version);
    static bool isNewerVersion(
        const QString &candidate,
        bool candidatePrerelease,
        const QString &current
    );

    QNetworkAccessManager m_network;
    bool m_busy{false};
    bool m_updateAvailable{false};
    QString m_latestVersion;
    QString m_statusText{QStringLiteral("Not checked yet")};
    QUrl m_releaseUrl;
};
