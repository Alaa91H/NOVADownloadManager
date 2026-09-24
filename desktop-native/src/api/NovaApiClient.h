#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QObject>
#include <QUrl>

class NovaApiClient final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool connected READ connected NOTIFY connectionChanged)
    Q_PROPERTY(QString statusText READ statusText NOTIFY connectionChanged)

public:
    explicit NovaApiClient(QObject *parent = nullptr);

    bool connected() const noexcept { return m_connected; }
    QString statusText() const { return m_statusText; }

    void setBaseUrl(const QUrl &baseUrl);
    void setBearerToken(const QString &token);

    Q_INVOKABLE void checkHealth();
    Q_INVOKABLE void refreshDownloads();
    Q_INVOKABLE void startDownloadStream();
    Q_INVOKABLE void createDownload(
        const QString &url,
        const QString &name,
        const QString &savePath,
        bool startImmediately
    );
    Q_INVOKABLE void updateDownloadMetadata(
        const QString &id,
        const QString &name,
        const QString &url
    );
    Q_INVOKABLE void pauseDownload(const QString &id);
    Q_INVOKABLE void resumeDownload(const QString &id);
    Q_INVOKABLE void redownloadDownload(const QString &id);
    Q_INVOKABLE void deleteDownload(const QString &id);

signals:
    void connectionChanged();
    void downloadsLoaded(const QJsonArray &downloads);
    void requestFailed(const QString &message);
    void taskActionCompleted(const QString &action, const QString &taskId);
    void downloadCreated(const QString &taskId);
    void downloadCreationFailed(const QString &message);
    void downloadUpdated(const QString &taskId);
    void downloadUpdateFailed(const QString &message);

private:
    QNetworkRequest makeRequest(const QString &path) const;
    void setConnectionState(bool connected, const QString &text);
    void runTaskAction(const QString &id, const QString &action);
    void processStreamChunk();
    void processStreamEvent(const QByteArray &eventBlock);
    void mergeDownloadsDelta(const QJsonObject &delta);

    QNetworkAccessManager m_network;
    QUrl m_baseUrl{QStringLiteral("http://127.0.0.1:3199")};
    QString m_bearerToken;
    bool m_connected{false};
    QString m_statusText{QStringLiteral("Connecting…")};

    QNetworkReply *m_streamReply{nullptr};
    QByteArray m_streamBuffer;
    QJsonArray m_currentDownloads;
};
