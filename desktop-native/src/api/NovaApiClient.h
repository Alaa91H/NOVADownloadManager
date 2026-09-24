#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QObject>
#include <QStringList>
#include <QTimer>
#include <QUrl>
#include <QUrlQuery>
#include <QVariantList>
#include <QVariantMap>

class NovaApiClient final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool connected READ connected NOTIFY connectionChanged)
    Q_PROPERTY(QString statusText READ statusText NOTIFY connectionChanged)
    Q_PROPERTY(QVariantList queueEntries READ queueEntries NOTIFY queueChanged)
    Q_PROPERTY(QStringList knownQueueIds READ knownQueueIds NOTIFY queueCatalogChanged)
    Q_PROPERTY(int queueActiveCount READ queueActiveCount NOTIFY queueChanged)
    Q_PROPERTY(qint64 queueTotalBandwidthKbps READ queueTotalBandwidthKbps NOTIFY queueChanged)
    Q_PROPERTY(QString nextQueuedTask READ nextQueuedTask NOTIFY queueChanged)
    Q_PROPERTY(QVariantList schedulerRules READ schedulerRules NOTIFY schedulerChanged)
    Q_PROPERTY(QVariantList activeSchedulerRuleIds READ activeSchedulerRuleIds NOTIFY schedulerChanged)
    Q_PROPERTY(bool batchRunning READ batchRunning NOTIFY batchStateChanged)
    Q_PROPERTY(bool mediaProbeBusy READ mediaProbeBusy NOTIFY mediaProbeChanged)
    Q_PROPERTY(QVariantMap mediaProbe READ mediaProbe NOTIFY mediaProbeChanged)
    Q_PROPERTY(QVariantList mediaFormats READ mediaFormats NOTIFY mediaProbeChanged)
    Q_PROPERTY(bool mediaPlaylistBusy READ mediaPlaylistBusy NOTIFY mediaPlaylistChanged)
    Q_PROPERTY(QString mediaPlaylistTitle READ mediaPlaylistTitle NOTIFY mediaPlaylistChanged)
    Q_PROPERTY(QVariantList mediaPlaylistEntries READ mediaPlaylistEntries NOTIFY mediaPlaylistChanged)
    Q_PROPERTY(bool ffmpegAvailable READ ffmpegAvailable NOTIFY ffmpegChanged)
    Q_PROPERTY(bool directProbeBusy READ directProbeBusy NOTIFY directProbeChanged)
    Q_PROPERTY(QVariantMap directProbe READ directProbe NOTIFY directProbeChanged)
    Q_PROPERTY(QVariantMap engineCapabilities READ engineCapabilities NOTIFY engineManagementChanged)
    Q_PROPERTY(QVariantList engineProfiles READ engineProfiles NOTIFY engineManagementChanged)
    Q_PROPERTY(QString activeEngineProfile READ activeEngineProfile NOTIFY engineManagementChanged)
    Q_PROPERTY(QVariantMap bandwidthState READ bandwidthState NOTIFY engineManagementChanged)
    Q_PROPERTY(QVariantMap retryPolicy READ retryPolicy NOTIFY engineManagementChanged)
    Q_PROPERTY(bool diagnosticsBusy READ diagnosticsBusy NOTIFY diagnosticsChanged)
    Q_PROPERTY(QVariantMap diagnosticsReport READ diagnosticsReport NOTIFY diagnosticsChanged)
    Q_PROPERTY(QVariantList logEntries READ logEntries NOTIFY logsChanged)
    Q_PROPERTY(QString logLevel READ logLevel NOTIFY logsChanged)
    Q_PROPERTY(QString logDirectory READ logDirectory NOTIFY logsChanged)
    Q_PROPERTY(bool browserIntegrationBusy READ browserIntegrationBusy NOTIFY browserIntegrationChanged)
    Q_PROPERTY(QVariantMap browserIntegrationHealth READ browserIntegrationHealth NOTIFY browserIntegrationChanged)
    Q_PROPERTY(bool liveUpdatesConnected READ liveUpdatesConnected NOTIFY liveUpdatesChanged)

public:
    explicit NovaApiClient(QObject *parent = nullptr);

    bool connected() const noexcept { return m_connected; }
    QString statusText() const { return m_statusText; }
    QVariantList queueEntries() const { return m_queueEntries; }
    QStringList knownQueueIds() const { return m_knownQueueIds; }
    int queueActiveCount() const noexcept { return m_queueActiveCount; }
    qint64 queueTotalBandwidthKbps() const noexcept { return m_queueTotalBandwidthKbps; }
    QString nextQueuedTask() const { return m_nextQueuedTask; }
    QVariantList schedulerRules() const { return m_schedulerRules; }
    QVariantList activeSchedulerRuleIds() const { return m_activeSchedulerRuleIds; }
    bool batchRunning() const noexcept { return m_batchRunning; }
    bool mediaProbeBusy() const noexcept { return m_mediaProbeBusy; }
    QVariantMap mediaProbe() const { return m_mediaProbe; }
    QVariantList mediaFormats() const { return m_mediaFormats; }
    bool mediaPlaylistBusy() const noexcept { return m_mediaPlaylistBusy; }
    QString mediaPlaylistTitle() const { return m_mediaPlaylistTitle; }
    QVariantList mediaPlaylistEntries() const { return m_mediaPlaylistEntries; }
    bool ffmpegAvailable() const noexcept { return m_ffmpegAvailable; }
    bool directProbeBusy() const noexcept { return m_directProbeBusy; }
    QVariantMap directProbe() const { return m_directProbe; }
    QVariantMap engineCapabilities() const { return m_engineCapabilities; }
    QVariantList engineProfiles() const { return m_engineProfiles; }
    QString activeEngineProfile() const { return m_activeEngineProfile; }
    QVariantMap bandwidthState() const { return m_bandwidthState; }
    QVariantMap retryPolicy() const { return m_retryPolicy; }
    bool diagnosticsBusy() const noexcept { return m_diagnosticsBusy; }
    QVariantMap diagnosticsReport() const { return m_diagnosticsReport; }
    QVariantList logEntries() const { return m_logEntries; }
    QString logLevel() const { return m_logLevel; }
    QString logDirectory() const { return m_logDirectory; }
    bool browserIntegrationBusy() const noexcept { return m_browserIntegrationBusy; }
    QVariantMap browserIntegrationHealth() const { return m_browserIntegrationHealth; }
    bool liveUpdatesConnected() const noexcept { return m_liveUpdatesConnected; }

    static int streamReconnectDelayForAttempt(int attempt) noexcept;

    void setBaseUrl(const QUrl &baseUrl);
    void setBearerToken(const QString &token);
    void reportBootstrapFailure(const QString &message);

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
    Q_INVOKABLE bool directOptionSupported(const QString &key) const;

    Q_INVOKABLE void refreshScheduler();
    Q_INVOKABLE void addSchedulerRule(const QVariantMap &rule);
    Q_INVOKABLE void setSchedulerRuleEnabled(const QString &ruleId, bool enabled);
    Q_INVOKABLE void deleteSchedulerRule(const QString &ruleId);

    Q_INVOKABLE void importBatch(
        const QString &input,
        const QString &saveDirectory,
        int connections,
        bool startImmediately,
        const QVariantMap &batchOptions
    );

    Q_INVOKABLE void probeMedia(const QString &url);
    Q_INVOKABLE void probeMediaPlaylist(const QString &url);
    Q_INVOKABLE void refreshFfmpegStatus();
    Q_INVOKABLE void createMediaDownload(
        const QString &url,
        const QString &name,
        const QString &saveDirectory,
        const QVariantMap &mediaOptions,
        bool startImmediately
    );

    Q_INVOKABLE void probeDirectLink(const QString &url);
    Q_INVOKABLE void createDirectFromProbe(
        const QString &saveDirectory,
        bool startImmediately
    );

    Q_INVOKABLE void refreshEngineManagement();
    Q_INVOKABLE void refreshEngineCapabilities();
    Q_INVOKABLE void refreshEngineProfiles();
    Q_INVOKABLE void setActiveEngineProfile(const QString &profileId);
    Q_INVOKABLE void refreshBandwidthState();
    Q_INVOKABLE void setGlobalBandwidthLimit(qint64 kbps);
    Q_INVOKABLE void setBandwidthPaused(bool paused);
    Q_INVOKABLE void refreshRetryPolicy();
    Q_INVOKABLE void applyRetryPreset(const QString &preset);

    Q_INVOKABLE void runDiagnostics();
    Q_INVOKABLE void saveDiagnosticsReport();
    Q_INVOKABLE void refreshLogs(const QString &minimumLevel = QString(), int limit = 300);
    Q_INVOKABLE void setLogLevel(const QString &level);

    Q_INVOKABLE void refreshBrowserIntegration();
    Q_INVOKABLE void setBrowserCaptureEnabled(bool enabled);

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
    void queueCatalogChanged();
    void queueActionCompleted(const QString &taskId);
    void schedulerChanged();
    void schedulerActionCompleted(const QString &action, const QString &ruleId);

    void batchStateChanged();
    void batchImportStarted(int total, int duplicateCount);
    void batchImportProgress(int completed, int total, int accepted, int failed);
    void batchImportFinished(int total, int accepted, int failed, int duplicateCount);

    void mediaProbeChanged();
    void mediaProbeFailed(const QString &message);
    void mediaPlaylistChanged();
    void mediaPlaylistFailed(const QString &message);
    void ffmpegChanged();
    void mediaDownloadCreated(const QString &taskId);

    void directProbeChanged();
    void directProbeFailed(const QString &message);
    void directDownloadCreated(const QString &taskId);

    void engineManagementChanged();
    void engineManagementFailed(const QString &message);
    void diagnosticsChanged();
    void diagnosticsFailed(const QString &message);
    void diagnosticsSaved(const QString &path);
    void logsChanged();
    void logsFailed(const QString &message);

    void browserIntegrationChanged();
    void browserIntegrationFailed(const QString &message);

    void liveUpdatesChanged();
    void streamReconnectScheduled(int delayMs);

private:
    QNetworkRequest makeRequest(const QString &path) const;
    QNetworkRequest makeRequest(const QString &path, const QUrlQuery &query) const;
    void setConnectionState(bool connected, const QString &text);
    void runTaskAction(const QString &id, const QString &action);
    void processStreamChunk();
    void processStreamEvent(const QByteArray &eventBlock);
    void setLiveUpdatesConnected(bool connected);
    void scheduleStreamReconnect();
    void mergeDownloadsDelta(const QJsonObject &delta);
    void sendSchedulerRule(const QJsonObject &rule, const QString &path, const QString &action);
    void pumpBatchRequests();
    void sendNextBatchRequest();
    void recomputeKnownQueueIds();

    QNetworkAccessManager m_network;
    QUrl m_baseUrl{QStringLiteral("http://127.0.0.1:3199")};
    QString m_bearerToken;
    bool m_connected{false};
    QString m_statusText{QStringLiteral("Connecting…")};

    QNetworkReply *m_streamReply{nullptr};
    QByteArray m_streamBuffer;
    QJsonArray m_currentDownloads;
    QTimer *m_streamReconnectTimer{nullptr};
    int m_streamReconnectAttempt{0};
    bool m_liveUpdatesConnected{false};

    QVariantList m_queueEntries;
    QStringList m_knownQueueIds{QStringLiteral("main")};
    int m_queueActiveCount{0};
    qint64 m_queueTotalBandwidthKbps{0};
    QString m_nextQueuedTask;

    QVariantList m_schedulerRules;
    QVariantList m_activeSchedulerRuleIds;

    bool m_batchRunning{false};
    QStringList m_batchUrls;
    QString m_batchSaveDirectory;
    QString m_batchQueueId{QStringLiteral("main")};
    QVariantMap m_batchAdvancedOptions;
    int m_batchConnections{0};
    bool m_batchStartImmediately{false};
    int m_batchDuplicateCount{0};
    int m_batchNextIndex{0};
    int m_batchInFlight{0};
    int m_batchAccepted{0};
    int m_batchFailed{0};

    bool m_mediaProbeBusy{false};
    QVariantMap m_mediaProbe;
    QVariantList m_mediaFormats;
    bool m_mediaPlaylistBusy{false};
    QString m_mediaPlaylistTitle;
    QVariantList m_mediaPlaylistEntries;
    bool m_ffmpegAvailable{false};

    bool m_directProbeBusy{false};
    QVariantMap m_directProbe;

    QVariantMap m_engineCapabilities;
    QVariantList m_engineProfiles;
    QString m_activeEngineProfile;
    QVariantMap m_bandwidthState;
    QVariantMap m_retryPolicy;

    bool m_diagnosticsBusy{false};
    QVariantMap m_diagnosticsReport;

    QVariantList m_logEntries;
    QString m_logLevel{QStringLiteral("info")};
    QString m_logDirectory;

    bool m_browserIntegrationBusy{false};
    QVariantMap m_browserIntegrationHealth;
};
