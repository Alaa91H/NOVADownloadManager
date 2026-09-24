#include "api/NovaApiClient.h"
#include "batch/BatchPatternExpander.h"

#include <QDir>
#include <QFileInfo>
#include <QHash>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QMap>
#include <QMetaType>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QScopeGuard>
#include <QSet>
#include <QStringList>
#include <QTimer>
#include <QUrl>
#include <QUrlQuery>
#include <QtGlobal>

namespace {

QString responseErrorMessage(QNetworkReply *reply, const QByteArray &payload) {
    const QJsonDocument document = QJsonDocument::fromJson(payload);
    if (document.isObject()) {
        const QString serverMessage = document.object().value(QStringLiteral("error")).toString();
        if (!serverMessage.isEmpty()) {
            return serverMessage;
        }
    }

    return reply->errorString();
}

} // namespace

NovaApiClient::NovaApiClient(QObject *parent)
    : QObject(parent),
      m_streamReconnectTimer(new QTimer(this)) {
    m_streamReconnectTimer->setSingleShot(true);
    connect(
        m_streamReconnectTimer,
        &QTimer::timeout,
        this,
        &NovaApiClient::startDownloadStream
    );
}

int NovaApiClient::streamReconnectDelayForAttempt(int attempt) noexcept {
    const int boundedAttempt = qBound(0, attempt, 5);
    const int delay = 250 * (1 << boundedAttempt);
    return qMin(delay, 5000);
}

void NovaApiClient::setLiveUpdatesConnected(bool connected) {
    if (m_liveUpdatesConnected == connected) {
        return;
    }
    m_liveUpdatesConnected = connected;
    emit liveUpdatesChanged();
}

void NovaApiClient::scheduleStreamReconnect() {
    if (m_streamReconnectTimer->isActive()) {
        return;
    }

    const int delay = streamReconnectDelayForAttempt(m_streamReconnectAttempt++);
    m_streamReconnectTimer->start(delay);
    emit streamReconnectScheduled(delay);
}

void NovaApiClient::setBaseUrl(const QUrl &baseUrl) {
    if (baseUrl.isValid() && !baseUrl.isEmpty()) {
        m_baseUrl = baseUrl;
    }
}

void NovaApiClient::setBearerToken(const QString &token) {
    m_bearerToken = token.trimmed();
}

void NovaApiClient::reportBootstrapFailure(const QString &message) {
    const QString text = message.trimmed().isEmpty()
        ? QStringLiteral("NOVA engine bootstrap failed")
        : message.trimmed();
    setConnectionState(false, text);
    emit requestFailed(text);
}

QNetworkRequest NovaApiClient::makeRequest(const QString &path) const {
    QUrl url = m_baseUrl;
    QString normalizedPath = path;
    if (!normalizedPath.startsWith('/')) {
        normalizedPath.prepend('/');
    }
    url.setPath(normalizedPath);

    QNetworkRequest request(url);
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setRawHeader("Accept", "application/json");
    if (!m_bearerToken.isEmpty()) {
        request.setRawHeader("Authorization", QByteArray("Bearer ") + m_bearerToken.toUtf8());
    }
    return request;
}

QNetworkRequest NovaApiClient::makeRequest(const QString &path, const QUrlQuery &query) const {
    QNetworkRequest request = makeRequest(path);
    QUrl url = request.url();
    url.setQuery(query);
    request.setUrl(url);
    return request;
}

void NovaApiClient::setConnectionState(bool connected, const QString &text) {
    if (m_connected == connected && m_statusText == text) {
        return;
    }
    m_connected = connected;
    m_statusText = text;
    emit connectionChanged();
}

void NovaApiClient::checkHealth() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/health")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const bool wasConnected = m_connected;

        if (reply->error() != QNetworkReply::NoError) {
            setConnectionState(false, QStringLiteral("Engine unavailable"));
            setLiveUpdatesConnected(false);
            emit requestFailed(reply->errorString());
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(reply->readAll());
        const QJsonObject root = document.object();
        const QString status = root.value(QStringLiteral("status")).toString();
        const bool healthy = status == QStringLiteral("connected")
            || status == QStringLiteral("ready")
            || status == QStringLiteral("degraded");
        setConnectionState(
            healthy,
            healthy ? QStringLiteral("Engine ready") : QStringLiteral("Engine unavailable")
        );

        if (healthy && !wasConnected) {
            m_streamReconnectAttempt = 0;
            refreshDownloads();
            startDownloadStream();
        }
    });
}

void NovaApiClient::refreshDownloads() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/downloads")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });

        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(reply->errorString());
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(reply->readAll());
        if (!document.isArray()) {
            emit requestFailed(QStringLiteral("Unexpected downloads response"));
            return;
        }

        m_currentDownloads = document.array();
        recomputeKnownQueueIds();
        emit downloadsLoaded(m_currentDownloads);
    });
}

void NovaApiClient::createDownload(
    const QString &url,
    const QString &name,
    const QString &savePath,
    bool startImmediately
) {
    createDownloadAdvanced(
        url,
        name,
        savePath,
        startImmediately,
        0,
        QVariantMap{}
    );
}

void NovaApiClient::createDownloadAdvanced(
    const QString &url,
    const QString &name,
    const QString &savePath,
    bool startImmediately,
    int connections,
    const QVariantMap &directOptions
) {
    const QString trimmedUrl = url.trimmed();
    if (trimmedUrl.isEmpty()) {
        emit downloadCreationFailed(QStringLiteral("Enter a download URL."));
        return;
    }

    QJsonObject body;
    body.insert(QStringLiteral("url"), trimmedUrl);
    body.insert(QStringLiteral("startImmediately"), startImmediately);
    body.insert(QStringLiteral("connections"), qBound(0, connections, 64));

    const QString trimmedName = name.trimmed();
    if (!trimmedName.isEmpty()) {
        body.insert(QStringLiteral("name"), trimmedName);
    }

    const QString trimmedSavePath = savePath.trimmed();
    if (!trimmedSavePath.isEmpty()) {
        body.insert(QStringLiteral("savePath"), trimmedSavePath);
    }

    QVariantMap filteredOptions;
    const QVariant supportedRaw =
        m_engineCapabilities.value(QStringLiteral("supportedDirectOptionKeys"));
    const QStringList supported = supportedRaw.toStringList();
    for (auto it = directOptions.constBegin(); it != directOptions.constEnd(); ++it) {
        if (!it.value().isValid() || it.value().isNull()) {
            continue;
        }
        if (!supported.isEmpty() && !supported.contains(it.key())) {
            continue;
        }
        if (it.value().metaType().id() == QMetaType::QString
            && it.value().toString().trimmed().isEmpty()) {
            continue;
        }
        filteredOptions.insert(it.key(), it.value());
    }
    if (!filteredOptions.isEmpty()) {
        body.insert(
            QStringLiteral("directOptions"),
            QJsonObject::fromVariantMap(filteredOptions)
        );
    }

    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/downloads")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();

        if (reply->error() != QNetworkReply::NoError) {
            emit downloadCreationFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit downloadCreationFailed(QStringLiteral("Unexpected create-download response."));
            return;
        }

        const QString taskId = document.object().value(QStringLiteral("id")).toString();
        emit downloadCreated(taskId);
        refreshDownloads();
    });
}

void NovaApiClient::updateDownloadMetadata(
    const QString &id,
    const QString &name,
    const QString &url
) {
    const QString trimmedId = id.trimmed();
    const QString trimmedName = name.trimmed();
    const QString trimmedUrl = url.trimmed();

    if (trimmedId.isEmpty()) {
        emit downloadUpdateFailed(QStringLiteral("No download is selected."));
        return;
    }
    if (trimmedName.isEmpty()) {
        emit downloadUpdateFailed(QStringLiteral("The file name cannot be empty."));
        return;
    }
    if (trimmedUrl.isEmpty()) {
        emit downloadUpdateFailed(QStringLiteral("The source URL cannot be empty."));
        return;
    }

    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(trimmedId));
    QJsonObject body;
    body.insert(QStringLiteral("name"), trimmedName);
    body.insert(QStringLiteral("url"), trimmedUrl);

    auto *reply = m_network.sendCustomRequest(
        makeRequest(QStringLiteral("/api/downloads/%1").arg(encodedId)),
        QByteArrayLiteral("PATCH"),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply, trimmedId]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();

        if (reply->error() != QNetworkReply::NoError) {
            emit downloadUpdateFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit downloadUpdateFailed(QStringLiteral("Unexpected update response."));
            return;
        }

        emit downloadUpdated(trimmedId);
        refreshDownloads();
    });
}

void NovaApiClient::startDownloadStream() {
    if (m_streamReply || (m_streamReconnectTimer && m_streamReconnectTimer->isActive())) {
        return;
    }

    QNetworkRequest request = makeRequest(QStringLiteral("/api/downloads/events"));
    request.setRawHeader("Accept", "text/event-stream");
    m_streamReply = m_network.get(request);

    connect(
        m_streamReply,
        &QNetworkReply::metaDataChanged,
        this,
        [this]() {
            if (!m_streamReply) {
                return;
            }
            const int status = m_streamReply
                ->attribute(QNetworkRequest::HttpStatusCodeAttribute)
                .toInt();
            if (status >= 200 && status < 300) {
                m_streamReconnectAttempt = 0;
                setLiveUpdatesConnected(true);
            }
        }
    );
    connect(m_streamReply, &QNetworkReply::readyRead, this, &NovaApiClient::processStreamChunk);
    connect(m_streamReply, &QNetworkReply::finished, this, [this]() {
        if (!m_streamReply) {
            return;
        }

        const bool wasLive = m_liveUpdatesConnected;
        const QString errorText = m_streamReply->error() == QNetworkReply::NoError
            ? QStringLiteral("Live updates disconnected")
            : m_streamReply->errorString();

        m_streamReply->deleteLater();
        m_streamReply = nullptr;
        m_streamBuffer.clear();
        setLiveUpdatesConnected(false);

        if (wasLive) {
            emit requestFailed(errorText);
        }
        scheduleStreamReconnect();
    });
}

void NovaApiClient::processStreamChunk() {
    if (!m_streamReply) {
        return;
    }

    m_streamBuffer += m_streamReply->readAll();

    while (true) {
        int separator = m_streamBuffer.indexOf("\n\n");
        int separatorLength = 2;
        if (separator < 0) {
            separator = m_streamBuffer.indexOf("\r\n\r\n");
            separatorLength = 4;
        }
        if (separator < 0) {
            break;
        }

        const QByteArray eventBlock = m_streamBuffer.left(separator);
        m_streamBuffer.remove(0, separator + separatorLength);
        processStreamEvent(eventBlock);
    }
}

void NovaApiClient::processStreamEvent(const QByteArray &eventBlock) {
    QByteArray eventName;
    QByteArray data;

    const QList<QByteArray> lines = eventBlock.split('\n');
    for (QByteArray line : lines) {
        line = line.trimmed();
        if (line.startsWith("event:")) {
            eventName = line.mid(6).trimmed();
        } else if (line.startsWith("data:")) {
            if (!data.isEmpty()) {
                data.append('\n');
            }
            data.append(line.mid(5).trimmed());
        }
    }

    if (data.isEmpty()) {
        return;
    }

    const QJsonDocument document = QJsonDocument::fromJson(data);
    if (eventName == "downloads" && document.isArray()) {
        m_streamReconnectAttempt = 0;
        setLiveUpdatesConnected(true);
        m_currentDownloads = document.array();
        recomputeKnownQueueIds();
        emit downloadsLoaded(m_currentDownloads);
        return;
    }

    if (eventName == "downloads-delta" && document.isObject()) {
        m_streamReconnectAttempt = 0;
        setLiveUpdatesConnected(true);
        mergeDownloadsDelta(document.object());
    }
}

void NovaApiClient::mergeDownloadsDelta(const QJsonObject &delta) {
    const QJsonArray changed = delta.value(QStringLiteral("changed")).toArray();
    const QJsonArray removed = delta.value(QStringLiteral("removed")).toArray();

    QSet<QString> removedIds;
    for (const auto &value : removed) {
        removedIds.insert(value.toString());
    }

    QHash<QString, QJsonObject> changedById;
    for (const auto &value : changed) {
        const QJsonObject object = value.toObject();
        const QString id = object.value(QStringLiteral("id")).toString();
        if (!id.isEmpty()) {
            changedById.insert(id, object);
        }
    }

    QSet<QString> existingIds;
    QJsonArray next;

    for (const auto &value : m_currentDownloads) {
        const QJsonObject object = value.toObject();
        const QString id = object.value(QStringLiteral("id")).toString();
        if (removedIds.contains(id)) {
            continue;
        }

        if (changedById.contains(id)) {
            next.append(changedById.value(id));
        } else {
            next.append(object);
        }
        existingIds.insert(id);
    }

    for (const auto &value : changed) {
        const QJsonObject object = value.toObject();
        const QString id = object.value(QStringLiteral("id")).toString();
        if (!id.isEmpty() && !existingIds.contains(id)) {
            next.append(object);
        }
    }

    m_currentDownloads = next;
    recomputeKnownQueueIds();
    emit downloadsLoaded(m_currentDownloads);
}

void NovaApiClient::runTaskAction(const QString &id, const QString &action) {
    if (id.isEmpty()) {
        return;
    }

    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(id));
    const QString path = QStringLiteral("/api/downloads/%1/%2").arg(encodedId, action);
    auto *reply = m_network.post(makeRequest(path), QByteArray());

    connect(reply, &QNetworkReply::finished, this, [this, reply, id, action]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();

        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        emit taskActionCompleted(action, id);
        refreshDownloads();
    });
}

void NovaApiClient::pauseDownload(const QString &id) {
    runTaskAction(id, QStringLiteral("pause"));
}

void NovaApiClient::resumeDownload(const QString &id) {
    runTaskAction(id, QStringLiteral("resume"));
}

void NovaApiClient::redownloadDownload(const QString &id) {
    runTaskAction(id, QStringLiteral("redownload"));
}

void NovaApiClient::resumeAllDownloads() {
    const QJsonArray snapshot = m_currentDownloads;
    for (const QJsonValue &value : snapshot) {
        const QJsonObject task = value.toObject();
        const QString status = task.value(QStringLiteral("status")).toString().trimmed().toLower();
        if (status == QStringLiteral("paused")
            || status == QStringLiteral("queued")
            || status == QStringLiteral("failed")
            || status == QStringLiteral("error")
            || status == QStringLiteral("interrupted")) {
            runTaskAction(task.value(QStringLiteral("id")).toString(), QStringLiteral("resume"));
        }
    }
}

void NovaApiClient::pauseAllDownloads() {
    const QJsonArray snapshot = m_currentDownloads;
    for (const QJsonValue &value : snapshot) {
        const QJsonObject task = value.toObject();
        const QString status = task.value(QStringLiteral("status")).toString().trimmed().toLower();
        if (status == QStringLiteral("queued")
            || status == QStringLiteral("preparing")
            || status == QStringLiteral("probing")
            || status == QStringLiteral("downloading")
            || status == QStringLiteral("retrying")
            || status == QStringLiteral("recovering")
            || status == QStringLiteral("failed")
            || status == QStringLiteral("error")
            || status == QStringLiteral("interrupted")) {
            runTaskAction(task.value(QStringLiteral("id")).toString(), QStringLiteral("pause"));
        }
    }
}

void NovaApiClient::deleteCompletedDownloads() {
    const QJsonArray snapshot = m_currentDownloads;
    for (const QJsonValue &value : snapshot) {
        const QJsonObject task = value.toObject();
        if (task.value(QStringLiteral("status")).toString().trimmed().compare(
                QStringLiteral("completed"),
                Qt::CaseInsensitive
            ) == 0) {
            deleteDownload(task.value(QStringLiteral("id")).toString());
        }
    }
}

void NovaApiClient::deleteDownload(const QString &id) {
    if (id.isEmpty()) {
        return;
    }

    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(id));
    auto *reply = m_network.deleteResource(makeRequest(QStringLiteral("/api/downloads/%1").arg(encodedId)));

    connect(reply, &QNetworkReply::finished, this, [this, reply, id]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();

        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        emit taskActionCompleted(QStringLiteral("delete"), id);
        refreshDownloads();
    });
}


bool NovaApiClient::directOptionSupported(const QString &key) const {
    const QString normalized = key.trimmed();
    if (normalized.isEmpty()) {
        return false;
    }

    const QVariantMap engines =
        m_engineCapabilities.value(QStringLiteral("engines")).toMap();
    const QVariantMap curl = engines.value(QStringLiteral("curl")).toMap();
    // Capabilities may not have been fetched yet. Preserve normal daemon-side
    // validation until the runtime capability snapshot arrives. Once the curl
    // engine publishes the key list, an empty list means no advanced options
    // are available and must not be treated as "unknown".
    if (!curl.contains(QStringLiteral("supportedDirectOptionKeys"))) {
        return true;
    }

    const QVariantList supported =
        curl.value(QStringLiteral("supportedDirectOptionKeys")).toList();

    for (const QVariant &value : supported) {
        if (value.toString() == normalized) {
            return true;
        }
    }
    return false;
}

bool NovaApiClient::mediaOptionSupported(const QString &key) const {
    const QString normalized = key.trimmed();
    if (normalized.isEmpty()) {
        return false;
    }

    if (m_engineCapabilities.contains(QStringLiteral("mediaReady"))
        && !m_engineCapabilities.value(QStringLiteral("mediaReady")).toBool()) {
        return false;
    }

    const QVariantMap engines =
        m_engineCapabilities.value(QStringLiteral("engines")).toMap();
    const QVariantMap mediaEngine = engines.value(QStringLiteral("ytdlp")).toMap();
    if (!mediaEngine.contains(QStringLiteral("supportedMediaOptionKeys"))) {
        return true;
    }

    const QVariantList supported =
        mediaEngine.value(QStringLiteral("supportedMediaOptionKeys")).toList();
    for (const QVariant &value : supported) {
        if (value.toString() == normalized) {
            return true;
        }
    }
    return false;
}

QVariantMap NovaApiClient::sanitizeMediaOptions(const QVariantMap &options) const {
    QVariantMap sanitized;
    for (auto it = options.constBegin(); it != options.constEnd(); ++it) {
        if (!mediaOptionSupported(it.key())) {
            continue;
        }

        const QVariant &value = it.value();
        if (!value.isValid() || value.isNull()) {
            continue;
        }
        if (value.metaType().id() == QMetaType::QString
            && value.toString().trimmed().isEmpty()) {
            continue;
        }
        sanitized.insert(it.key(), value);
    }
    return sanitized;
}

void NovaApiClient::recomputeKnownQueueIds() {
    QStringList nextIds;
    QStringList nextLabels;
    QSet<QString> seen;

    const auto appendQueue = [&nextIds, &nextLabels, &seen](
        const QString &id,
        const QString &label
    ) {
        const QString normalizedId = id.trimmed();
        if (normalizedId.isEmpty() || seen.contains(normalizedId)) {
            return;
        }
        seen.insert(normalizedId);
        nextIds.append(normalizedId);
        nextLabels.append(label.trimmed().isEmpty() ? normalizedId : label.trimmed());
    };

    for (const QVariant &value : m_queueCatalog) {
        const QVariantMap queue = value.toMap();
        appendQueue(
            queue.value(QStringLiteral("id")).toString(),
            queue.value(QStringLiteral("name")).toString()
        );
    }

    if (!seen.contains(QStringLiteral("main"))) {
        nextIds.prepend(QStringLiteral("main"));
        nextLabels.prepend(QStringLiteral("Main Queue"));
        seen.insert(QStringLiteral("main"));
    } else {
        const int mainIndex = nextIds.indexOf(QStringLiteral("main"));
        if (mainIndex > 0) {
            const QString mainId = nextIds.takeAt(mainIndex);
            const QString mainLabel = nextLabels.takeAt(mainIndex);
            nextIds.prepend(mainId);
            nextLabels.prepend(mainLabel);
        }
    }

    QStringList liveExtras;
    for (const QJsonValue &value : m_currentDownloads) {
        const QString queueId = value.toObject()
            .value(QStringLiteral("queueId"))
            .toString()
            .trimmed();
        if (!queueId.isEmpty() && !seen.contains(queueId)) {
            liveExtras.append(queueId);
            seen.insert(queueId);
        }
    }
    liveExtras.sort(Qt::CaseInsensitive);
    for (const QString &queueId : liveExtras) {
        nextIds.append(queueId);
        nextLabels.append(queueId);
    }

    if (nextIds == m_knownQueueIds && nextLabels == m_knownQueueLabels) {
        return;
    }

    m_knownQueueIds = nextIds;
    m_knownQueueLabels = nextLabels;
    emit queueCatalogChanged();
}

void NovaApiClient::applyQueueCatalog(const QJsonArray &queues) {
    QVariantList catalog = queues.toVariantList();
    if (catalog.isEmpty()) {
        catalog.append(QVariantMap{
            {QStringLiteral("id"), QStringLiteral("main")},
            {QStringLiteral("name"), QStringLiteral("Main Queue")},
            {QStringLiteral("downloadOrder"), QVariantList{}}
        });
    }

    m_queueCatalog = catalog;
    recomputeKnownQueueIds();
    emit queueCatalogChanged();
}

QVariantMap NovaApiClient::queueById(const QString &queueId) const {
    const QString id = queueId.trimmed();
    for (const QVariant &value : m_queueCatalog) {
        const QVariantMap queue = value.toMap();
        if (queue.value(QStringLiteral("id")).toString() == id) {
            return queue;
        }
    }
    return {};
}

QStringList NovaApiClient::orderedQueueTaskIds(const QString &queueId) const {
    const QString id = queueId.trimmed();
    const QVariantMap queue = queueById(id);
    QStringList ids;
    QSet<QString> seen;

    for (const QVariant &value : queue.value(QStringLiteral("downloadOrder")).toList()) {
        const QString taskId = value.toString().trimmed();
        if (!taskId.isEmpty() && !seen.contains(taskId)) {
            seen.insert(taskId);
            ids.append(taskId);
        }
    }

    QStringList extras;
    for (const QJsonValue &value : m_currentDownloads) {
        const QJsonObject task = value.toObject();
        if (task.value(QStringLiteral("queueId")).toString() != id) {
            continue;
        }
        const QString taskId = task.value(QStringLiteral("id")).toString().trimmed();
        if (!taskId.isEmpty() && !seen.contains(taskId)) {
            seen.insert(taskId);
            extras.append(taskId);
        }
    }
    extras.sort(Qt::CaseInsensitive);
    ids.append(extras);
    return ids;
}

void NovaApiClient::refreshQueueCatalog() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/queues")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();

        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected queue catalog response."));
            return;
        }

        applyQueueCatalog(document.object().value(QStringLiteral("queues")).toArray());
    });
}

void NovaApiClient::createQueue(const QString &nameText, const QString &taskIdText) {
    const QString name = nameText.trimmed();
    if (name.isEmpty()) {
        emit requestFailed(QStringLiteral("Queue name cannot be empty."));
        return;
    }

    QJsonObject body;
    body.insert(QStringLiteral("name"), name);
    const QString taskId = taskIdText.trimmed();
    if (!taskId.isEmpty()) {
        body.insert(QStringLiteral("taskId"), taskId);
    }

    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/queues")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected queue-create response."));
            return;
        }
        const QJsonObject root = document.object();
        applyQueueCatalog(root.value(QStringLiteral("queues")).toArray());
        emit queueCatalogActionCompleted(
            QStringLiteral("create"),
            root.value(QStringLiteral("queue")).toObject().value(QStringLiteral("id")).toString()
        );
        refreshDownloads();
    });
}

void NovaApiClient::updateQueue(const QVariantMap &queue) {
    const QString queueId = queue.value(QStringLiteral("id")).toString().trimmed();
    if (queueId.isEmpty()) {
        emit requestFailed(QStringLiteral("Queue id is required."));
        return;
    }

    QJsonObject body;
    body.insert(QStringLiteral("queue"), QJsonObject::fromVariantMap(queue));
    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(queueId));
    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/queues/%1").arg(encodedId)),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply, queueId]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected queue-update response."));
            return;
        }

        applyQueueCatalog(document.object().value(QStringLiteral("queues")).toArray());
        emit queueCatalogActionCompleted(QStringLiteral("update"), queueId);
        refreshQueue();
    });
}

void NovaApiClient::deleteQueue(const QString &queueIdText) {
    const QString queueId = queueIdText.trimmed();
    if (queueId.isEmpty() || queueId == QStringLiteral("main")) {
        emit requestFailed(QStringLiteral("The main queue cannot be deleted."));
        return;
    }

    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(queueId));
    auto *reply = m_network.deleteResource(
        makeRequest(QStringLiteral("/api/queues/%1").arg(encodedId))
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply, queueId]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected queue-delete response."));
            return;
        }
        applyQueueCatalog(document.object().value(QStringLiteral("queues")).toArray());
        emit queueCatalogActionCompleted(QStringLiteral("delete"), queueId);
        refreshDownloads();
        refreshQueue();
    });
}

void NovaApiClient::moveQueue(const QString &queueIdText, int offset) {
    const QString queueId = queueIdText.trimmed();
    if (queueId.isEmpty() || offset == 0) {
        return;
    }

    QStringList ids;
    for (const QVariant &value : m_queueCatalog) {
        const QString id = value.toMap().value(QStringLiteral("id")).toString();
        if (!id.isEmpty()) {
            ids.append(id);
        }
    }

    const int from = ids.indexOf(queueId);
    const int to = from + offset;
    if (from < 0 || to < 0 || to >= ids.size()) {
        return;
    }
    ids.move(from, to);

    QJsonArray queueIds;
    for (const QString &id : ids) {
        queueIds.append(id);
    }
    QJsonObject body{{QStringLiteral("queueIds"), queueIds}};
    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/queues/reorder")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply, queueId]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }
        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected queue-reorder response."));
            return;
        }
        applyQueueCatalog(document.object().value(QStringLiteral("queues")).toArray());
        emit queueCatalogActionCompleted(QStringLiteral("reorder"), queueId);
    });
}

void NovaApiClient::moveTaskToQueue(const QString &taskIdText, const QString &queueIdText) {
    const QString taskId = taskIdText.trimmed();
    const QString queueId = queueIdText.trimmed();
    if (taskId.isEmpty() || queueId.isEmpty()) {
        return;
    }

    const QString encodedQueue = QString::fromUtf8(QUrl::toPercentEncoding(queueId));
    const QString encodedTask = QString::fromUtf8(QUrl::toPercentEncoding(taskId));
    auto *reply = m_network.post(
        makeRequest(
            QStringLiteral("/api/queues/%1/tasks/%2").arg(encodedQueue, encodedTask)
        ),
        QByteArrayLiteral("{}")
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply, taskId, queueId]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }
        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected queue-move response."));
            return;
        }
        applyQueueCatalog(document.object().value(QStringLiteral("queues")).toArray());
        emit queueCatalogActionCompleted(QStringLiteral("move-task"), queueId);
        emit queueActionCompleted(taskId);
        refreshDownloads();
        refreshQueue();
    });
}

void NovaApiClient::moveQueueTask(
    const QString &queueIdText,
    const QString &taskIdText,
    int offset
) {
    const QString queueId = queueIdText.trimmed();
    const QString taskId = taskIdText.trimmed();
    if (queueId.isEmpty() || taskId.isEmpty() || offset == 0) {
        return;
    }

    QStringList taskIds = orderedQueueTaskIds(queueId);
    const int from = taskIds.indexOf(taskId);
    const int to = from + offset;
    if (from < 0 || to < 0 || to >= taskIds.size()) {
        return;
    }
    taskIds.move(from, to);

    QJsonArray order;
    for (const QString &id : taskIds) {
        order.append(id);
    }
    QJsonObject body{{QStringLiteral("taskIds"), order}};

    const QString encodedQueue = QString::fromUtf8(QUrl::toPercentEncoding(queueId));
    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/queues/%1/tasks/reorder").arg(encodedQueue)),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply, queueId, taskId]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }
        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected queue-task reorder response."));
            return;
        }
        applyQueueCatalog(document.object().value(QStringLiteral("queues")).toArray());
        emit queueCatalogActionCompleted(QStringLiteral("reorder-task"), queueId);
        emit queueActionCompleted(taskId);
    });
}

void NovaApiClient::startQueue(const QString &queueIdText) {
    const QString queueId = queueIdText.trimmed();
    const QVariantMap queue = queueById(queueId);
    if (queue.isEmpty()) {
        emit requestFailed(QStringLiteral("Queue was not found."));
        return;
    }

    const int maxActive = qBound(
        1,
        queue.value(QStringLiteral("maxActive"), 1).toInt(),
        64
    );
    int active = 0;
    QHash<QString, QString> statuses;
    for (const QJsonValue &value : m_currentDownloads) {
        const QJsonObject task = value.toObject();
        if (task.value(QStringLiteral("queueId")).toString() != queueId) {
            continue;
        }
        const QString taskId = task.value(QStringLiteral("id")).toString();
        const QString status = task.value(QStringLiteral("status")).toString();
        statuses.insert(taskId, status);
        if (status == QStringLiteral("downloading")) {
            ++active;
        }
    }

    int slots = qMax(0, maxActive - active);
    for (const QString &taskId : orderedQueueTaskIds(queueId)) {
        if (slots <= 0) {
            break;
        }
        const QString status = statuses.value(taskId);
        if (status == QStringLiteral("queued") || status == QStringLiteral("paused")) {
            resumeDownload(taskId);
            --slots;
        }
    }
    emit queueCatalogActionCompleted(QStringLiteral("start"), queueId);
}

void NovaApiClient::stopQueue(const QString &queueIdText) {
    const QString queueId = queueIdText.trimmed();
    if (queueId.isEmpty()) {
        return;
    }
    for (const QJsonValue &value : m_currentDownloads) {
        const QJsonObject task = value.toObject();
        if (task.value(QStringLiteral("queueId")).toString() == queueId
            && task.value(QStringLiteral("status")).toString() == QStringLiteral("downloading")) {
            pauseDownload(task.value(QStringLiteral("id")).toString());
        }
    }
    emit queueCatalogActionCompleted(QStringLiteral("stop"), queueId);
}

void NovaApiClient::refreshQueue() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/engine/queue")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected queue response."));
            return;
        }

        const QJsonObject root = document.object();
        m_queueEntries = root.value(QStringLiteral("entries")).toArray().toVariantList();
        m_queueActiveCount = root.value(QStringLiteral("active_count")).toInt();
        m_queueTotalBandwidthKbps = root.value(QStringLiteral("total_bandwidth_kbps")).toInteger();
        m_nextQueuedTask = root.value(QStringLiteral("next_to_start")).toString();
        emit queueChanged();
    });
}

void NovaApiClient::setQueuePriority(const QString &taskId, int priority) {
    const QString trimmedId = taskId.trimmed();
    if (trimmedId.isEmpty()) {
        return;
    }

    QJsonObject body;
    body.insert(QStringLiteral("task_id"), trimmedId);
    body.insert(QStringLiteral("priority"), qBound(0, priority, 4));

    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/engine/queue")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply, trimmedId]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        emit queueActionCompleted(trimmedId);
        refreshQueue();
    });
}

void NovaApiClient::refreshScheduler() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/engine/scheduler")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected scheduler response."));
            return;
        }

        const QJsonObject root = document.object();
        m_schedulerRules = root.value(QStringLiteral("rules")).toArray().toVariantList();
        m_activeSchedulerRuleIds = root.value(QStringLiteral("active_rule_ids")).toArray().toVariantList();
        m_schedulerPowerCommandsEnabled =
            root.value(QStringLiteral("powerCommandsEnabled")).toBool(false);

        const bool exitRequested =
            root.value(QStringLiteral("exitRequested")).toBool(false);
        if (exitRequested && !m_schedulerExitRequested) {
            m_schedulerExitRequested = true;
            emit schedulerExitRequested();
        } else if (!exitRequested) {
            m_schedulerExitRequested = false;
        }

        emit schedulerChanged();
    });
}

void NovaApiClient::setSchedulerPowerCommandsEnabled(bool enabled) {
    QJsonObject body{{QStringLiteral("enabled"), enabled}};
    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/engine/scheduler/power-commands")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }
        refreshScheduler();
    });
}

void NovaApiClient::sendSchedulerRule(
    const QJsonObject &rule,
    const QString &path,
    const QString &action
) {
    if (rule.value(QStringLiteral("id")).toString().trimmed().isEmpty()) {
        emit requestFailed(QStringLiteral("Scheduler rule id is required."));
        return;
    }

    QJsonObject body;
    body.insert(QStringLiteral("rule"), rule);
    auto *reply = m_network.post(
        makeRequest(path),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    const QString ruleId = rule.value(QStringLiteral("id")).toString();
    connect(reply, &QNetworkReply::finished, this, [this, reply, action, ruleId]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        emit schedulerActionCompleted(action, ruleId);
        refreshScheduler();
    });
}

void NovaApiClient::addSchedulerRule(const QVariantMap &rule) {
    sendSchedulerRule(
        QJsonObject::fromVariantMap(rule),
        QStringLiteral("/api/engine/scheduler"),
        QStringLiteral("add")
    );
}

void NovaApiClient::setSchedulerRuleEnabled(const QString &ruleId, bool enabled) {
    for (const QVariant &value : m_schedulerRules) {
        QVariantMap map = value.toMap();
        if (map.value(QStringLiteral("id")).toString() != ruleId) {
            continue;
        }

        map.insert(QStringLiteral("enabled"), enabled);
        sendSchedulerRule(
            QJsonObject::fromVariantMap(map),
            QStringLiteral("/api/engine/scheduler/update"),
            enabled ? QStringLiteral("enable") : QStringLiteral("disable")
        );
        return;
    }

    emit requestFailed(QStringLiteral("Scheduler rule was not found."));
}

void NovaApiClient::deleteSchedulerRule(const QString &ruleId) {
    const QString trimmedId = ruleId.trimmed();
    if (trimmedId.isEmpty()) {
        return;
    }

    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(trimmedId));
    auto *reply = m_network.deleteResource(
        makeRequest(QStringLiteral("/api/engine/scheduler/%1").arg(encodedId))
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply, trimmedId]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        emit schedulerActionCompleted(QStringLiteral("delete"), trimmedId);
        refreshScheduler();
    });
}

QVariantMap NovaApiClient::batchExpansionPreview(const QString &input) const {
    const Nova::BatchPattern::CountResult result =
        Nova::BatchPattern::countInput(input);

    QVariantMap preview;
    preview.insert(QStringLiteral("count"), result.count);
    preview.insert(QStringLiteral("overflow"), !result.ok());
    preview.insert(QStringLiteral("error"), result.error);
    return preview;
}

void NovaApiClient::importBatch(
    const QString &input,
    const QString &saveDirectory,
    int connections,
    bool startImmediately,
    const QVariantMap &batchOptions
) {
    if (m_batchRunning) {
        emit requestFailed(QStringLiteral("A batch import is already running."));
        return;
    }

    if (m_engineCapabilities.contains(QStringLiteral("directReady"))
        && !m_engineCapabilities.value(QStringLiteral("directReady")).toBool()) {
        emit requestFailed(QStringLiteral("The NOVA direct-download engine is not ready."));
        return;
    }

    const Nova::BatchPattern::ExpansionResult expansion =
        Nova::BatchPattern::expandInput(input);
    if (!expansion.ok()) {
        emit requestFailed(expansion.error);
        return;
    }
    const QStringList candidates = expansion.urls;

    QSet<QString> supportedProtocols;
    for (const QVariant &protocol :
         m_engineCapabilities.value(QStringLiteral("directProtocols")).toList()) {
        const QString normalized = protocol.toString().trimmed().toLower();
        if (!normalized.isEmpty()) {
            supportedProtocols.insert(normalized);
        }
    }

    QSet<QString> seen;
    QStringList uniqueUrls;
    int duplicates = 0;
    for (const QString &candidate : candidates) {
        const QString value = candidate.trimmed();
        const QUrl url(value);
        if (!url.isValid() || url.scheme().isEmpty()) {
            continue;
        }

        if (!supportedProtocols.isEmpty()
            && !supportedProtocols.contains(url.scheme().toLower())) {
            continue;
        }

        if (seen.contains(value)) {
            ++duplicates;
            continue;
        }
        seen.insert(value);
        uniqueUrls.append(value);
    }

    if (uniqueUrls.isEmpty()) {
        emit requestFailed(QStringLiteral("No valid URLs were found in the batch."));
        return;
    }

    m_batchRunning = true;
    m_batchUrls = uniqueUrls;
    m_batchSaveDirectory = saveDirectory.trimmed();

    const QString requestedQueueId =
        batchOptions.value(QStringLiteral("queueId")).toString().trimmed();
    static const QRegularExpression queueIdPattern(
        QStringLiteral(R"(^[A-Za-z0-9._:-]{1,128}$)")
    );
    m_batchQueueId = queueIdPattern.match(requestedQueueId).hasMatch()
        ? requestedQueueId
        : QStringLiteral("main");

    m_batchAdvancedOptions.clear();
    const QVariantMap requestedOptions =
        batchOptions.value(QStringLiteral("advanced")).toMap();

    const auto insertStringOption = [this, &requestedOptions](const QString &key) {
        if (!directOptionSupported(key)) {
            return;
        }
        const QString value = requestedOptions.value(key).toString().trimmed();
        if (!value.isEmpty()) {
            m_batchAdvancedOptions.insert(key, value);
        }
    };

    for (const QString &key : {
             QStringLiteral("referer"),
             QStringLiteral("userAgent"),
             QStringLiteral("proxy"),
             QStringLiteral("headers"),
             QStringLiteral("cookies")
         }) {
        insertStringOption(key);
    }

    const int retryCount = requestedOptions.value(QStringLiteral("retryCount")).toInt();
    if (retryCount > 0 && directOptionSupported(QStringLiteral("retryCount"))) {
        m_batchAdvancedOptions.insert(
            QStringLiteral("retryCount"),
            qBound(1, retryCount, 100)
        );
    }

    const int timeoutSec = requestedOptions.value(QStringLiteral("timeoutSec")).toInt();
    if (timeoutSec > 0 && directOptionSupported(QStringLiteral("timeoutSec"))) {
        m_batchAdvancedOptions.insert(
            QStringLiteral("timeoutSec"),
            qBound(1, timeoutSec, 3600)
        );
    }

    const bool segmentedSupported =
        directOptionSupported(QStringLiteral("segmented"))
        && directOptionSupported(QStringLiteral("range"));
    m_batchConnections = segmentedSupported
        ? qBound(0, connections, 32)
        : 1;
    if (m_batchConnections > 1) {
        m_batchAdvancedOptions.insert(QStringLiteral("segmented"), true);
    }
    m_batchStartImmediately = startImmediately;
    m_batchDuplicateCount = duplicates;
    m_batchNextIndex = 0;
    m_batchInFlight = 0;
    m_batchAccepted = 0;
    m_batchFailed = 0;

    emit batchStateChanged();
    emit batchImportStarted(m_batchUrls.size(), m_batchDuplicateCount);
    pumpBatchRequests();
}

void NovaApiClient::pumpBatchRequests() {
    constexpr int maxConcurrentRequests = 4;
    while (m_batchRunning
           && m_batchInFlight < maxConcurrentRequests
           && m_batchNextIndex < m_batchUrls.size()) {
        sendNextBatchRequest();
    }

    if (!m_batchRunning || m_batchInFlight > 0 || m_batchNextIndex < m_batchUrls.size()) {
        return;
    }

    const int total = m_batchUrls.size();
    const int accepted = m_batchAccepted;
    const int failed = m_batchFailed;
    const int duplicates = m_batchDuplicateCount;

    m_batchRunning = false;
    emit batchStateChanged();
    emit batchImportFinished(total, accepted, failed, duplicates);
    refreshDownloads();
    refreshQueue();
}

void NovaApiClient::sendNextBatchRequest() {
    if (m_batchNextIndex >= m_batchUrls.size()) {
        return;
    }

    const QString urlText = m_batchUrls.at(m_batchNextIndex++);
    const QUrl url(urlText);
    QString fileName = QFileInfo(url.path()).fileName();
    if (fileName.isEmpty()) {
        fileName = QStringLiteral("download");
    }

    QJsonObject body;
    body.insert(QStringLiteral("url"), urlText);
    body.insert(QStringLiteral("name"), fileName);
    body.insert(QStringLiteral("fileType"), QStringLiteral("other"));
    body.insert(QStringLiteral("category"), QStringLiteral("other"));
    body.insert(QStringLiteral("queueId"), m_batchQueueId);
    body.insert(QStringLiteral("connections"), m_batchConnections);
    body.insert(QStringLiteral("resumable"), true);
    body.insert(QStringLiteral("description"), QStringLiteral("Native batch import"));
    body.insert(QStringLiteral("startImmediately"), m_batchStartImmediately);

    if (!m_batchSaveDirectory.isEmpty()) {
        body.insert(
            QStringLiteral("savePath"),
            QDir(m_batchSaveDirectory).filePath(fileName)
        );
    }

    if (!m_batchAdvancedOptions.isEmpty()) {
        body.insert(
            QStringLiteral("directOptions"),
            QJsonObject::fromVariantMap(m_batchAdvancedOptions)
        );
    }

    ++m_batchInFlight;
    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/downloads")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();

        --m_batchInFlight;
        if (reply->error() == QNetworkReply::NoError) {
            const QJsonDocument document = QJsonDocument::fromJson(payload);
            if (document.isObject()) {
                ++m_batchAccepted;
            } else {
                ++m_batchFailed;
            }
        } else {
            ++m_batchFailed;
        }

        const int completed = m_batchAccepted + m_batchFailed;
        emit batchImportProgress(
            completed,
            m_batchUrls.size(),
            m_batchAccepted,
            m_batchFailed
        );
        pumpBatchRequests();
    });
}


void NovaApiClient::probeMedia(const QString &urlText) {
    const QString url = urlText.trimmed();
    if (url.isEmpty()) {
        emit mediaProbeFailed(QStringLiteral("Enter a media URL."));
        return;
    }

    m_mediaProbeBusy = true;
    m_mediaProbe.clear();
    m_mediaFormats.clear();
    emit mediaProbeChanged();

    QUrlQuery query;
    query.addQueryItem(QStringLiteral("url"), url);
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/ytdlp/probe"), query));

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        m_mediaProbeBusy = false;

        if (reply->error() != QNetworkReply::NoError) {
            emit mediaProbeChanged();
            emit mediaProbeFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit mediaProbeChanged();
            emit mediaProbeFailed(QStringLiteral("Unexpected media probe response."));
            return;
        }

        const QJsonObject root = document.object();
        QVariantMap summary;
        summary.insert(QStringLiteral("id"), root.value(QStringLiteral("id")).toVariant());
        summary.insert(QStringLiteral("title"), root.value(QStringLiteral("title")).toString());
        summary.insert(QStringLiteral("duration"), root.value(QStringLiteral("duration")).toDouble());
        summary.insert(QStringLiteral("durationString"), root.value(QStringLiteral("durationString")).toString());
        summary.insert(QStringLiteral("thumbnail"), root.value(QStringLiteral("thumbnail")).toString());
        summary.insert(QStringLiteral("webpageUrl"), root.value(QStringLiteral("webpageUrl")).toString());
        m_mediaProbe = summary;

        QMap<int, QVariantMap> bestByHeight;
        const QJsonArray formats = root.value(QStringLiteral("formats")).toArray();
        for (const QJsonValue &value : formats) {
            const QJsonObject format = value.toObject();
            const int height = format.value(QStringLiteral("height")).toInt();
            if (height <= 0) {
                continue;
            }

            const QString vcodec = format.value(QStringLiteral("vcodec")).toString();
            if (vcodec.isEmpty() || vcodec == QStringLiteral("none")) {
                continue;
            }

            const qint64 fileSize = format.value(QStringLiteral("filesize")).toInteger(
                format.value(QStringLiteral("filesize_approx")).toInteger()
            );

            QVariantMap item;
            item.insert(QStringLiteral("formatId"), format.value(QStringLiteral("format_id")).toString());
            item.insert(QStringLiteral("height"), height);
            item.insert(QStringLiteral("width"), format.value(QStringLiteral("width")).toInt());
            item.insert(QStringLiteral("ext"), format.value(QStringLiteral("ext")).toString());
            item.insert(QStringLiteral("filesize"), fileSize);
            item.insert(QStringLiteral("vcodec"), vcodec);
            item.insert(QStringLiteral("acodec"), format.value(QStringLiteral("acodec")).toString());
            item.insert(QStringLiteral("fps"), format.value(QStringLiteral("fps")).toDouble());
            item.insert(QStringLiteral("tbr"), format.value(QStringLiteral("tbr")).toDouble());
            item.insert(QStringLiteral("formatNote"), format.value(QStringLiteral("format_note")).toString());

            const auto existing = bestByHeight.constFind(height);
            if (existing == bestByHeight.constEnd()
                || item.value(QStringLiteral("filesize")).toLongLong()
                    > existing.value().value(QStringLiteral("filesize")).toLongLong()) {
                bestByHeight.insert(height, item);
            }
        }

        m_mediaFormats.clear();
        auto it = bestByHeight.constEnd();
        while (it != bestByHeight.constBegin()) {
            --it;
            m_mediaFormats.append(it.value());
        }

        emit mediaProbeChanged();
    });
}

void NovaApiClient::probeMediaPlaylist(const QString &urlText) {
    const QString url = urlText.trimmed();
    if (url.isEmpty()) {
        emit mediaPlaylistFailed(QStringLiteral("Enter a playlist URL."));
        return;
    }

    m_mediaPlaylistBusy = true;
    m_mediaPlaylistTitle.clear();
    m_mediaPlaylistEntries.clear();
    emit mediaPlaylistChanged();

    QUrlQuery query;
    query.addQueryItem(QStringLiteral("url"), url);
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/ytdlp/probe-playlist"), query));

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        m_mediaPlaylistBusy = false;

        if (reply->error() != QNetworkReply::NoError) {
            emit mediaPlaylistChanged();
            emit mediaPlaylistFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit mediaPlaylistChanged();
            emit mediaPlaylistFailed(QStringLiteral("Unexpected playlist probe response."));
            return;
        }

        const QJsonObject root = document.object();
        m_mediaPlaylistTitle = root.value(QStringLiteral("title")).toString();
        m_mediaPlaylistEntries = root.value(QStringLiteral("entries")).toArray().toVariantList();
        emit mediaPlaylistChanged();
    });
}

void NovaApiClient::refreshFfmpegStatus() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/ytdlp/ffmpeg")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        bool available = false;

        if (reply->error() == QNetworkReply::NoError) {
            const QJsonDocument document = QJsonDocument::fromJson(payload);
            if (document.isObject()) {
                available = document.object().value(QStringLiteral("available")).toBool();
            }
        }

        if (m_ffmpegAvailable != available) {
            m_ffmpegAvailable = available;
            emit ffmpegChanged();
        }
    });
}

void NovaApiClient::createMediaDownload(
    const QString &urlText,
    const QString &nameText,
    const QString &saveDirectory,
    const QVariantMap &mediaOptions,
    bool startImmediately
) {
    const QString url = urlText.trimmed();
    if (url.isEmpty()) {
        emit mediaProbeFailed(QStringLiteral("Enter a media URL."));
        return;
    }

    QString name = nameText.trimmed();
    if (name.isEmpty()) {
        name = m_mediaProbe.value(QStringLiteral("title")).toString().trimmed();
    }
    if (name.isEmpty()) {
        name = m_mediaPlaylistTitle.trimmed();
    }
    if (name.isEmpty()) {
        name = QStringLiteral("media");
    }

    if (m_engineCapabilities.contains(QStringLiteral("mediaReady"))
        && !m_engineCapabilities.value(QStringLiteral("mediaReady")).toBool()) {
        emit requestFailed(QStringLiteral("The NOVA media engine is not ready."));
        return;
    }

    const QVariantMap sanitizedOptions = sanitizeMediaOptions(mediaOptions);
    QJsonObject options = QJsonObject::fromVariantMap(sanitizedOptions);
    const QString mode = options.value(QStringLiteral("mode")).toString(QStringLiteral("video"));

    QJsonObject body;
    body.insert(QStringLiteral("url"), url);
    body.insert(QStringLiteral("name"), name);
    body.insert(QStringLiteral("fileType"), mode == QStringLiteral("audio")
        ? QStringLiteral("audio")
        : QStringLiteral("video"));
    body.insert(QStringLiteral("category"), mode == QStringLiteral("audio")
        ? QStringLiteral("audio")
        : QStringLiteral("video"));
    body.insert(QStringLiteral("queueId"), QStringLiteral("main"));
    body.insert(QStringLiteral("connections"), 1);
    body.insert(QStringLiteral("resumable"), true);
    body.insert(QStringLiteral("description"), QStringLiteral("Native media downloader request"));
    body.insert(QStringLiteral("startImmediately"), startImmediately);
    body.insert(QStringLiteral("mediaOptions"), options);

    const QString directory = saveDirectory.trimmed();
    if (!directory.isEmpty()) {
        QString placeholder = name;
        placeholder.replace(QRegularExpression(QStringLiteral(R"([\\/:*?"<>|])")), QStringLiteral("_"));
        placeholder = placeholder.trimmed();
        if (placeholder.isEmpty()) {
            placeholder = QStringLiteral("media");
        }
        body.insert(
            QStringLiteral("savePath"),
            QDir(directory).filePath(placeholder + QStringLiteral(".media"))
        );
    }

    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/downloads")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected media download response."));
            return;
        }

        const QString taskId = document.object().value(QStringLiteral("id")).toString();
        emit mediaDownloadCreated(taskId);
        refreshDownloads();
        refreshQueue();
    });
}

void NovaApiClient::probeDirectLink(const QString &urlText) {
    const QString url = urlText.trimmed();
    if (url.isEmpty()) {
        emit directProbeFailed(QStringLiteral("Enter a direct URL."));
        return;
    }

    m_directProbeBusy = true;
    m_directProbe.clear();
    emit directProbeChanged();

    QUrlQuery query;
    query.addQueryItem(QStringLiteral("url"), url);
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/probe"), query));

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        m_directProbeBusy = false;

        if (reply->error() != QNetworkReply::NoError) {
            emit directProbeChanged();
            emit directProbeFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit directProbeChanged();
            emit directProbeFailed(QStringLiteral("Unexpected link probe response."));
            return;
        }

        m_directProbe = document.object().toVariantMap();
        emit directProbeChanged();
    });
}

void NovaApiClient::createDirectFromProbe(
    const QString &saveDirectory,
    bool startImmediately
) {
    if (m_directProbe.isEmpty()) {
        emit directProbeFailed(QStringLiteral("Analyze a link before adding it."));
        return;
    }

    QString url = m_directProbe.value(QStringLiteral("finalUrl")).toString().trimmed();
    if (url.isEmpty()) {
        url = m_directProbe.value(QStringLiteral("url")).toString().trimmed();
    }
    if (url.isEmpty()) {
        emit directProbeFailed(QStringLiteral("The analyzed link has no usable URL."));
        return;
    }

    QString fileName = m_directProbe.value(QStringLiteral("fileName")).toString().trimmed();
    if (fileName.isEmpty()) {
        fileName = QFileInfo(QUrl(url).path()).fileName();
    }
    if (fileName.isEmpty()) {
        fileName = QStringLiteral("download");
    }

    QJsonObject body;
    body.insert(QStringLiteral("url"), url);
    body.insert(QStringLiteral("name"), fileName);
    body.insert(QStringLiteral("fileType"), m_directProbe.value(QStringLiteral("fileType")).toString());
    body.insert(QStringLiteral("sizeBytes"), m_directProbe.value(QStringLiteral("sizeBytes")).toLongLong());
    body.insert(QStringLiteral("category"), m_directProbe.value(QStringLiteral("fileType")).toString());
    body.insert(QStringLiteral("queueId"), QStringLiteral("main"));
    body.insert(QStringLiteral("connections"), 0);
    body.insert(QStringLiteral("resumable"), m_directProbe.value(QStringLiteral("resumable")).toBool());
    body.insert(QStringLiteral("description"), QStringLiteral("Native link grabber import"));
    body.insert(QStringLiteral("startImmediately"), startImmediately);

    const QString directory = saveDirectory.trimmed();
    if (!directory.isEmpty()) {
        body.insert(QStringLiteral("savePath"), QDir(directory).filePath(fileName));
    }

    const QVariant mirrors = m_directProbe.value(QStringLiteral("linkMirrors"));
    if (mirrors.isValid()) {
        QJsonObject directOptions;
        directOptions.insert(QStringLiteral("linkMirrors"), QJsonValue::fromVariant(mirrors));
        body.insert(QStringLiteral("directOptions"), directOptions);
    }

    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/downloads")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit directProbeFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit directProbeFailed(QStringLiteral("Unexpected add-download response."));
            return;
        }

        const QString taskId = document.object().value(QStringLiteral("id")).toString();
        emit directDownloadCreated(taskId);
        refreshDownloads();
        refreshQueue();
    });
}


void NovaApiClient::refreshEngineManagement() {
    refreshEngineCapabilities();
    refreshEngineProfiles();
    refreshBandwidthState();
    refreshRetryPolicy();
}

void NovaApiClient::refreshEngineCapabilities() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/engines/capabilities")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit engineManagementFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit engineManagementFailed(QStringLiteral("Unexpected engine capabilities response."));
            return;
        }

        m_engineCapabilities = document.object().toVariantMap();
        emit engineManagementChanged();
    });
}

void NovaApiClient::refreshEngineProfiles() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/engine/profiles")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit engineManagementFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit engineManagementFailed(QStringLiteral("Unexpected engine profiles response."));
            return;
        }

        const QJsonObject root = document.object();
        m_engineProfiles = root.value(QStringLiteral("profiles")).toArray().toVariantList();
        m_activeEngineProfile = root.value(QStringLiteral("active_profile")).toString();
        emit engineManagementChanged();
    });
}

void NovaApiClient::setActiveEngineProfile(const QString &profileId) {
    const QString id = profileId.trimmed();
    if (id.isEmpty()) {
        return;
    }

    QJsonObject body;
    body.insert(QStringLiteral("profile_id"), id);
    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/engine/profiles")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply, id]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit engineManagementFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject() || !document.object().value(QStringLiteral("ok")).toBool()) {
            emit engineManagementFailed(QStringLiteral("The engine rejected this profile."));
            return;
        }

        m_activeEngineProfile = id;
        emit engineManagementChanged();
        refreshBandwidthState();
        refreshRetryPolicy();
    });
}

void NovaApiClient::refreshBandwidthState() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/engine/bandwidth")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit engineManagementFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit engineManagementFailed(QStringLiteral("Unexpected bandwidth response."));
            return;
        }

        m_bandwidthState = document.object().toVariantMap();
        emit engineManagementChanged();
    });
}

void NovaApiClient::setGlobalBandwidthLimit(qint64 kbps) {
    QJsonObject body;
    body.insert(QStringLiteral("global_limit_kbps"), qMax<qint64>(0, kbps));

    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/engine/bandwidth")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit engineManagementFailed(responseErrorMessage(reply, payload));
            return;
        }
        refreshBandwidthState();
    });
}

void NovaApiClient::setBandwidthPaused(bool paused) {
    QJsonObject body;
    body.insert(QStringLiteral("paused"), paused);

    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/engine/bandwidth")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit engineManagementFailed(responseErrorMessage(reply, payload));
            return;
        }
        refreshBandwidthState();
    });
}

void NovaApiClient::refreshRetryPolicy() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/engine/retry-policy")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit engineManagementFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit engineManagementFailed(QStringLiteral("Unexpected retry-policy response."));
            return;
        }

        m_retryPolicy = document.object().value(QStringLiteral("policy")).toObject().toVariantMap();
        emit engineManagementChanged();
    });
}

void NovaApiClient::applyRetryPreset(const QString &presetText) {
    const QString preset = presetText.trimmed().toLower();
    static const QSet<QString> allowed{
        QStringLiteral("default"),
        QStringLiteral("aggressive"),
        QStringLiteral("conservative"),
        QStringLiteral("none")
    };
    if (!allowed.contains(preset)) {
        emit engineManagementFailed(QStringLiteral("Unknown retry preset."));
        return;
    }

    QJsonObject body;
    body.insert(QStringLiteral("preset"), preset);

    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/engine/retry-policy")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit engineManagementFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit engineManagementFailed(QStringLiteral("Unexpected retry-policy update response."));
            return;
        }

        m_retryPolicy = document.object().value(QStringLiteral("policy")).toObject().toVariantMap();
        emit engineManagementChanged();
    });
}

void NovaApiClient::runDiagnostics() {
    if (m_diagnosticsBusy) {
        return;
    }

    m_diagnosticsBusy = true;
    emit diagnosticsChanged();

    QNetworkRequest request = makeRequest(QStringLiteral("/api/diagnostics"));
    request.setTransferTimeout(50000);
    auto *reply = m_network.get(request);

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        m_diagnosticsBusy = false;

        if (reply->error() != QNetworkReply::NoError) {
            emit diagnosticsChanged();
            emit diagnosticsFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit diagnosticsChanged();
            emit diagnosticsFailed(QStringLiteral("Unexpected diagnostics response."));
            return;
        }

        m_diagnosticsReport = document.object().toVariantMap();
        emit diagnosticsChanged();
    });
}

void NovaApiClient::saveDiagnosticsReport() {
    if (m_diagnosticsReport.isEmpty()) {
        emit diagnosticsFailed(QStringLiteral("Run diagnostics before saving a report."));
        return;
    }

    QJsonObject body = QJsonObject::fromVariantMap(m_diagnosticsReport);
    body.insert(QStringLiteral("save"), true);

    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/diagnostics")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit diagnosticsFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit diagnosticsFailed(QStringLiteral("Unexpected diagnostics-save response."));
            return;
        }

        const QJsonObject root = document.object();
        if (!root.value(QStringLiteral("saved")).toBool()) {
            emit diagnosticsFailed(root.value(QStringLiteral("error")).toString(
                QStringLiteral("Diagnostics report could not be saved.")
            ));
            return;
        }

        emit diagnosticsSaved(root.value(QStringLiteral("path")).toString());
    });
}

void NovaApiClient::refreshLogs(const QString &minimumLevel, int limit) {
    QUrlQuery query;
    query.addQueryItem(QStringLiteral("limit"), QString::number(qBound(1, limit, 2000)));
    const QString normalizedLevel = minimumLevel.trimmed().toLower();
    if (!normalizedLevel.isEmpty() && normalizedLevel != QStringLiteral("all")) {
        query.addQueryItem(QStringLiteral("level"), normalizedLevel);
    }

    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/logs"), query));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit logsFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit logsFailed(QStringLiteral("Unexpected logs response."));
            return;
        }

        const QJsonObject root = document.object();
        m_logEntries = root.value(QStringLiteral("entries")).toArray().toVariantList();
        m_logLevel = root.value(QStringLiteral("level")).toString(m_logLevel);
        m_logDirectory = root.value(QStringLiteral("logDir")).toString();
        emit logsChanged();
    });
}

void NovaApiClient::setLogLevel(const QString &levelText) {
    const QString level = levelText.trimmed().toLower();
    static const QSet<QString> allowed{
        QStringLiteral("off"),
        QStringLiteral("error"),
        QStringLiteral("warn"),
        QStringLiteral("info"),
        QStringLiteral("debug"),
        QStringLiteral("trace")
    };
    if (!allowed.contains(level)) {
        emit logsFailed(QStringLiteral("Unknown log level."));
        return;
    }

    QJsonObject body;
    body.insert(QStringLiteral("level"), level);

    auto *reply = m_network.sendCustomRequest(
        makeRequest(QStringLiteral("/api/logs/level")),
        QByteArrayLiteral("PATCH"),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit logsFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (document.isObject()) {
            m_logLevel = document.object().value(QStringLiteral("level")).toString(m_logLevel);
        }
        emit logsChanged();
        refreshLogs(QString(), 300);
    });
}


void NovaApiClient::refreshSettingsServices() {
    refreshExternalTools();
    refreshTelegramConfig();
}

void NovaApiClient::refreshExternalTools() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/external-tools")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }
        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected external-tools response."));
            return;
        }
        m_externalTools =
            document.object().value(QStringLiteral("tools")).toArray().toVariantList();
        emit settingsServicesChanged();
    });
}

void NovaApiClient::runExternalToolAction(
    const QString &toolIdText,
    const QString &actionText,
    const QString &pathText
) {
    const QString toolId = toolIdText.trimmed();
    const QString action = actionText.trimmed().toLower();
    static const QSet<QString> allowed{
        QStringLiteral("discover"),
        QStringLiteral("health"),
        QStringLiteral("check-updates"),
        QStringLiteral("install"),
        QStringLiteral("update"),
        QStringLiteral("set-path"),
        QStringLiteral("uninstall")
    };
    if (toolId.isEmpty() || !allowed.contains(action)) {
        emit requestFailed(QStringLiteral("Invalid external-tool operation."));
        return;
    }

    const QString encodedTool = QString::fromUtf8(QUrl::toPercentEncoding(toolId));
    QJsonObject body;
    if (action == QStringLiteral("set-path")) {
        const QString path = pathText.trimmed();
        if (path.isEmpty()) {
            emit requestFailed(QStringLiteral("Choose a tool executable first."));
            return;
        }
        body.insert(QStringLiteral("path"), path);
    }

    auto *reply = m_network.post(
        makeRequest(
            QStringLiteral("/api/external-tools/%1/%2").arg(encodedTool, action)
        ),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply, toolId, action]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }
        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected external-tool action response."));
            return;
        }
        const QJsonObject root = document.object();
        if (root.contains(QStringLiteral("ok"))
            && !root.value(QStringLiteral("ok")).toBool()) {
            emit requestFailed(
                root.value(QStringLiteral("error")).toString(
                    QStringLiteral("External-tool operation failed.")
                )
            );
            return;
        }
        emit settingsServiceActionCompleted(
            QStringLiteral("external-tool"),
            QStringLiteral("%1:%2").arg(toolId, action)
        );
        refreshExternalTools();
        refreshEngineCapabilities();
    });
}

void NovaApiClient::refreshTelegramConfig() {
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/telegram/config")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }
        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected Telegram configuration response."));
            return;
        }
        m_telegramConfig = document.object().toVariantMap();
        emit settingsServicesChanged();
    });
}

void NovaApiClient::updateTelegramConfig(const QVariantMap &config) {
    QJsonObject body;
    for (const QString &key : {
             QStringLiteral("enabled"),
             QStringLiteral("token"),
             QStringLiteral("chatId"),
             QStringLiteral("apiBase"),
             QStringLiteral("fileUploadLimitMb")
         }) {
        if (config.contains(key)) {
            body.insert(key, QJsonValue::fromVariant(config.value(key)));
        }
    }

    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/telegram/config")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }
        emit settingsServiceActionCompleted(
            QStringLiteral("telegram"),
            QStringLiteral("saved")
        );
        refreshTelegramConfig();
    });
}

void NovaApiClient::testTelegram() {
    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/telegram/test")),
        QByteArrayLiteral("{}")
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }
        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()
            || !document.object().value(QStringLiteral("ok")).toBool()) {
            emit requestFailed(
                document.object().value(QStringLiteral("error")).toString(
                    QStringLiteral("Telegram test failed.")
                )
            );
            return;
        }
        emit settingsServiceActionCompleted(
            QStringLiteral("telegram-test"),
            QStringLiteral("ok")
        );
    });
}

void NovaApiClient::pingDnsProviders() {
    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/dns/ping-all")),
        QByteArrayLiteral("{}")
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(responseErrorMessage(reply, payload));
            return;
        }
        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit requestFailed(QStringLiteral("Unexpected DNS diagnostics response."));
            return;
        }
        m_dnsResults =
            document.object().value(QStringLiteral("results")).toArray().toVariantList();
        emit settingsServicesChanged();
        emit settingsServiceActionCompleted(
            QStringLiteral("dns"),
            QStringLiteral("complete")
        );
    });
}

void NovaApiClient::refreshBrowserIntegration() {
    if (!m_connected || m_browserIntegrationBusy) {
        return;
    }

    m_browserIntegrationBusy = true;
    emit browserIntegrationChanged();

    auto *reply = m_network.get(
        makeRequest(QStringLiteral("/api/browser-extension/health"))
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();

        m_browserIntegrationBusy = false;

        if (reply->error() != QNetworkReply::NoError) {
            emit browserIntegrationChanged();
            emit browserIntegrationFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit browserIntegrationChanged();
            emit browserIntegrationFailed(
                QStringLiteral("Unexpected browser integration response.")
            );
            return;
        }

        m_browserIntegrationHealth = document.object().toVariantMap();
        emit browserIntegrationChanged();
    });
}


void NovaApiClient::setBrowserCaptureEnabled(bool enabled) {
    if (!m_connected || m_browserIntegrationBusy) {
        return;
    }

    m_browserIntegrationBusy = true;
    emit browserIntegrationChanged();

    QJsonObject body;
    body.insert(QStringLiteral("enabled"), enabled);

    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/browser-extension/config")),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();

        m_browserIntegrationBusy = false;

        if (reply->error() != QNetworkReply::NoError) {
            emit browserIntegrationChanged();
            emit browserIntegrationFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()) {
            emit browserIntegrationChanged();
            emit browserIntegrationFailed(
                QStringLiteral("Unexpected browser integration configuration response.")
            );
            return;
        }

        const QJsonObject root = document.object();
        m_browserIntegrationHealth = root.toVariantMap();
        emit browserIntegrationChanged();

        if (root.value(QStringLiteral("configApplied")).isBool()
            && !root.value(QStringLiteral("configApplied")).toBool()) {
            emit browserIntegrationFailed(
                root.value(QStringLiteral("configError")).toString(
                    QStringLiteral("Browser integration settings could not be saved.")
                )
            );
        }
    });
}
