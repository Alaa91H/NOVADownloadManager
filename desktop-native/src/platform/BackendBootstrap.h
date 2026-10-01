#pragma once

#include <QNetworkAccessManager>
#include <QObject>
#include <QProcess>
#include <QTimer>
#include <QUrl>

class QNetworkReply;

class BackendBootstrap final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool ready READ ready NOTIFY stateChanged)
    Q_PROPERTY(QString statusText READ statusText NOTIFY stateChanged)

public:
    explicit BackendBootstrap(QObject *parent = nullptr);
    ~BackendBootstrap() override;

    bool ready() const noexcept { return m_ready; }
    QString statusText() const { return m_statusText; }

    Q_INVOKABLE void start();
    Q_INVOKABLE void recover();

signals:
    void stateChanged();
    void backendReady(const QUrl &baseUrl, const QString &bearerToken);
    void bootstrapFailed(const QString &message);

private:
    void setStatus(const QString &text);
    void beginProbeRound();
    void probeNextPort();
    void handleProbeReply(QNetworkReply *reply, const QUrl &baseUrl);
    bool launchBundledBackend();
    QString bundledBackendPath() const;

    QNetworkAccessManager m_network;
    QProcess m_backendProcess;
    QTimer m_retryTimer;
    int m_nextPort{3199};
    int m_round{0};
    bool m_startedBackend{false};
    bool m_ready{false};
    bool m_shuttingDown{false};
    QString m_statusText{QStringLiteral("Discovering NOVA engine…")};
};
