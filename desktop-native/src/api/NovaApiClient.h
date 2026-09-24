#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QObject>
#include <QStringList>
#include <QUrl>
#include <QVariantList>
#include <QVariantMap>

class NovaApiClient final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool connected READ connected NOTIFY connectionChanged)
    Q_PROPERTY(QString statusText READ statusText NOTIFY connectionChanged)
    Q_PROPERTY(QVariantList queueEntries READ queueEntries NOTIFY queueChanged)
    Q_PROPERTY(int queueActiveCount READ queueActiveCount NOTIFY queueChanged)
    Q_PROPERTY(qint64 queueTotalBandwidthKbps READ queueTotalBandwidthKbps NOTIFY queueChanged)
    Q_PROPERTY(QString nextQueuedTask READ nextQueuedTask NOTIFY queueChanged)
    Q_PROPERTY(QVariantList schedulerRules READ schedulerRules NOTIFY schedulerChanged)
    Q_PROPERTY(QVariantList activeSchedulerRuleIds READ activeSchedulerRuleIds NOTIFY schedulerChanged)
    Q_PROPERTY(bool batchRunning READ batchRunning NOTIFY batchStateChanged)

public:
    explicit NovaApiClient(QObject *parent = nullptr);

    bool connected() const noexcept { return m_connected; }
    QString statusText() const { return m_statusText; }
    QVariantList queueEntries() const { return m_queueEntries; }
    int queueActiveCount() const noexcept { return m_queueActiveCount; }
    qint64 queueTotalBandwidthKbps() const noexcept { return m_queueTotalBandwidthKbps; }
    QString nextQueuedTask() const { return m_nextQueuedTask; }
    QVariantList schedulerRules() const { return m_schedulerRules; }
    QVariantList activeSchedulerRuleIds() const { return m_activeSchedulerRuleIds; }
    bool batchRunning() const noexcept { return m_batchRunning; }

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

    Q_INVOKABLE void refreshQueue();
    Q_INVOKABLE void setQueuePriority(const QString &taskId, int priority);

    Q_INVOKABLE void refreshScheduler();
    Q_INVOKABLE void addSchedulerRule(const QVariantMap &rule);
    Q_INVOKABLE void setSchedulerRuleEnabled(const QString &ruleId, bool enabled);
    Q_INVOKABLE void deleteSchedulerRule(const QString &ruleId);

    Q_INVOKABLE void importBatch(
        const QString &input,
        const QString &saveDirectory,
        int connections,
        bool startImmediately
    );

signals:
    void connectionChanged();
    void downloadsLoaded(const QJsonArray &downloads);
    void requestFailed(const QString &message);
    void taskActionCompleted(const QString &action, const QString &taskId);
    void downloadCreated(const QString &taskId);
    void downloadCreationFailed(const QString &message);
    void downloadUpdated(const QString &taskId);
    void downloadUpdateFailed(const QString &message);

    void queueChanged();
    void queueActionCompleted(const QString &taskId);
    void schedulerChanged();
    void schedulerActionCompleted(const QString &action, const QString &ruleId);

    void batchStateChanged();
    void batchImportStarted(int total, int duplicateCount);
    void batchImportProgress(int completed, int total, int accepted, int failed);
    void batchImportFinished(int total, int accepted, int failed, int duplicateCount);

private:
    QNetworkRequest makeRequest(const QString &path) const;
    void setConnectionState(bool connected, const QString &text);
    void runTaskAction(const QString &id, const QString &action);
    void processStreamChunk();
    void processStreamEvent(const QByteArray &eventBlock);
    void mergeDownloadsDelta(const QJsonObject &delta);
    void sendSchedulerRule(const QJsonObject &rule, const QString &path, const QString &action);
    void pumpBatchRequests();
    void sendNextBatchRequest();

    QNetworkAccessManager m_network;
    QUrl m_baseUrl{QStringLiteral("http://127.0.0.1:3199")};
    QString m_bearerToken;
    bool m_connected{false};
    QString m_statusText{QStringLiteral("Connecting…")};

    QNetworkReply *m_streamReply{nullptr};
    QByteArray m_streamBuffer;
    QJsonArray m_currentDownloads;

    QVariantList m_queueEntries;
    int m_queueActiveCount{0};
    qint64 m_queueTotalBandwidthKbps{0};
    QString m_nextQueuedTask;

    QVariantList m_schedulerRules;
    QVariantList m_activeSchedulerRuleIds;

    bool m_batchRunning{false};
    QStringList m_batchUrls;
    QString m_batchSaveDirectory;
    int m_batchConnections{0};
    bool m_batchStartImmediately{false};
    int m_batchDuplicateCount{0};
    int m_batchNextIndex{0};
    int m_batchInFlight{0};
    int m_batchAccepted{0};
    int m_batchFailed{0};
};
