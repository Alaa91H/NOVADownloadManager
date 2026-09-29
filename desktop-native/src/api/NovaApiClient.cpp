#include "api/NovaApiClient.h"
#include "batch/BatchPatternExpander.h"

#include <QDir>
#include <QBuffer>
#include <QFile>
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
#include <QUuid>
#include <QtGlobal>
#include <algorithm>

namespace {

QString responseErrorMessage(QNetworkReply *reply, const QByteArray &payload) {
    const QJsonDocument document = QJsonDocument::fromJson(payload);
    if (document.isObject()) {
        const QJsonObject object = document.object();
        QString serverMessage = object.value(QStringLiteral("error")).toString();
        if (serverMessage.isEmpty()) {
            serverMessage = object.value(QStringLiteral("message")).toString();
        }
        if (serverMessage.isEmpty() && object.value(QStringLiteral("error")).isObject()) {
            const QJsonObject error = object.value(QStringLiteral("error")).toObject();
            serverMessage = error.value(QStringLiteral("message")).toString();
            if (serverMessage.isEmpty()) {
                serverMessage = error.value(QStringLiteral("code")).toString();
            }
        }
        if (!serverMessage.isEmpty()) {
            return serverMessage;
        }
    }

    return reply->errorString();
}

QJsonObject controlResultObject(const QJsonObject &document) {
    const QJsonValue result = document.value(QStringLiteral("result"));
    return result.isObject() ? result.toObject() : QJsonObject{};
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

QNetworkReply *NovaApiClient::postControlCommand(const QString &type, const QJsonObject &fields) {
    const QString requestId = QStringLiteral("desktop-%1")
        .arg(QUuid::createUuid().toString(QUuid::WithoutBraces));
    QJsonObject command;
    command.insert(QStringLiteral("type"), type);
    for (auto iterator = fields.constBegin(); iterator != fields.constEnd(); ++iterator) {
        command.insert(iterator.key(), iterator.value());
    }
    const QJsonObject envelope{
        {QStringLiteral("contractVersion"), 1},
        {QStringLiteral("requestId"), requestId},
        {QStringLiteral("idempotencyKey"), requestId},
        {QStringLiteral("command"), command},
    };
    return m_network.post(
        makeRequest(QStringLiteral("/api/v1/commands")),
        QJsonDocument(envelope).toJson(QJsonDocument::Compact)
    );
}

QNetworkReply *NovaApiClient::postControlQuery(const QString &type, const QJsonObject &fields) {
    const QString requestId = QStringLiteral("desktop-query-%1")
        .arg(QUuid::createUuid().toString(QUuid::WithoutBraces));
    QJsonObject query;
    query.insert(QStringLiteral("type"), type);
    for (auto iterator = fields.constBegin(); iterator != fields.constEnd(); ++iterator) {
        query.insert(iterator.key(), iterator.value());
    }
    const QJsonObject envelope{
        {QStringLiteral("contractVersion"), 1},
        {QStringLiteral("requestId"), requestId},
        {QStringLiteral("query"), query},
    };
    return m_network.post(
        makeRequest(QStringLiteral("/api/v1/queries")),
        QJsonDocument(envelope).toJson(QJsonDocument::Compact)
    );
}

void NovaApiClient::setConnectionState(bool connected, const QString &text) {
    if (m_connected == connected && m_statusText == text) {
        return;
    }
    m_connected = connected;
    m_statusText = text;
    emit connectionChanged();
}

QString NovaApiClient::controlPlaneCapabilityStatus(const QString &capabilityId) const {
    const QString requestedId = capabilityId.trimmed();
    const QVariantMap controlPlane = m_engineCapabilities.value(QStringLiteral("controlPlane")).toMap();
    const QVariantList capabilities = controlPlane.value(QStringLiteral("commandCapabilities")).toList();
    for (const QVariant &entryValue : capabilities) {
        const QVariantMap entry = entryValue.toMap();
        if (entry.value(QStringLiteral("id")).toString() == requestedId) {
            return entry.value(QStringLiteral("status")).toString(QStringLiteral("unavailable"));
        }
    }
    return QStringLiteral("unavailable");
}

bool NovaApiClient::controlPlaneCommandSupported(const QString &capabilityId) const {
    return controlPlaneCapabilityStatus(capabilityId) == QStringLiteral("supported");
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
            refreshEngineCapabilities();
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
    if (!controlPlaneCommandSupported(QStringLiteral("addDownload"))) {
        emit downloadCreationFailed(QStringLiteral("The Runtime does not report direct download as available."));
        return;
    }
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
    const QVariantMap engines =
        m_engineCapabilities.value(QStringLiteral("engines")).toMap();
    const QVariantMap curl = engines.value(QStringLiteral("curl")).toMap();
    const QVariantList supportedValues =
        curl.value(QStringLiteral("supportedDirectOptionKeys")).toList();
    QStringList supported;
    supported.reserve(supportedValues.size());
    for (const QVariant &value : supportedValues) {
        const QString key = value.toString();
        if (!key.isEmpty()) {
            supported.append(key);
        }
    }
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

    auto *reply = postControlCommand(
        QStringLiteral("addDownload"),
        QJsonObject{{QStringLiteral("request"), body}}
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

        const QJsonObject result = document.object().value(QStringLiteral("result")).toObject();
        const QString taskId = result.value(QStringLiteral("id")).toString();
        emit downloadCreated(taskId);
        refreshDownloads();
    });
}

void NovaApiClient::updateDownloadMetadata(
    const QString &id,
    const QString &name,
    const QString &url
) {
    if (!controlPlaneCommandSupported(QStringLiteral("updateTask"))) {
        emit downloadUpdateFailed(QStringLiteral("Task metadata updates are unavailable in this Runtime."));
        return;
    }
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

    auto *reply = postControlCommand(
        QStringLiteral("updateTask"),
        QJsonObject{
            {QStringLiteral("taskId"), trimmedId},
            {QStringLiteral("name"), trimmedName},
            {QStringLiteral("url"), trimmedUrl},
        }
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

    QString commandType;
    if (action == QStringLiteral("pause")) {
        commandType = QStringLiteral("pauseTask");
    } else if (action == QStringLiteral("resume")) {
        commandType = QStringLiteral("resumeTask");
    } else if (action == QStringLiteral("retry")) {
        commandType = QStringLiteral("retryTask");
    } else if (action == QStringLiteral("redownload")) {
        commandType = QStringLiteral("redownloadTask");
    }
    if (!commandType.isEmpty() && !controlPlaneCommandSupported(commandType)) {
        emit requestFailed(QStringLiteral("The requested task action is unavailable in this Runtime."));
        return;
    }
    auto *reply = commandType.isEmpty()
        ? m_network.post(
              makeRequest(QStringLiteral("/api/downloads/%1/%2").arg(
                  QString::fromUtf8(QUrl::toPercentEncoding(id)), action)),
              QByteArray()
          )
        : postControlCommand(
              commandType,
              QJsonObject{{QStringLiteral("taskId"), id}}
          );

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

void NovaApiClient::finishLiveRecording(const QString &id) {
    runTaskAction(id, QStringLiteral("finish"));
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
    if (!controlPlaneCommandSupported(QStringLiteral("deleteTask"))) {
        emit requestFailed(QStringLiteral("Task deletion is unavailable in this Runtime."));
        return;
    }
    if (id.isEmpty()) {
        return;
    }

    auto *reply = postControlCommand(
        QStringLiteral("deleteTask"),
        QJsonObject{{QStringLiteral("taskId"), id}, {QStringLiteral("deleteFiles"), false}}
    );

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

    if (m_engineCapabilities.contains(QStringLiteral("mediaExtractionReady"))
        && !m_engineCapabilities.value(QStringLiteral("mediaExtractionReady")).toBool()) {
        return false;
    }

    const QVariantMap engines =
        m_engineCapabilities.value(QStringLiteral("engines")).toMap();
    const QVariantMap mediaEngine = engines.value(QStringLiteral("media")).toMap();
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
    auto *reply = postControlQuery(QStringLiteral("listQueues"));
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

        applyQueueCatalog(controlResultObject(document.object())
            .value(QStringLiteral("queues")).toArray());
    });
}

void NovaApiClient::createQueue(const QString &nameText, const QString &taskIdText) {
    const QString name = nameText.trimmed();
    if (name.isEmpty()) {
        emit requestFailed(QStringLiteral("Queue name cannot be empty."));
        return;
    }
    if (!controlPlaneCommandSupported(QStringLiteral("createQueue"))) {
        emit requestFailed(QStringLiteral("Queue creation is unavailable in this Runtime."));
        return;
    }

    QJsonObject fields{{QStringLiteral("name"), name}};
    const QString taskId = taskIdText.trimmed();
    if (!taskId.isEmpty()) {
        fields.insert(QStringLiteral("taskId"), taskId);
    }

    auto *reply = postControlCommand(QStringLiteral("createQueue"), fields);
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
        const QJsonObject root = controlResultObject(document.object());
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
    if (!controlPlaneCommandSupported(QStringLiteral("updateQueue"))) {
        emit requestFailed(QStringLiteral("Queue updates are unavailable in this Runtime."));
        return;
    }

    auto *reply = postControlCommand(
        QStringLiteral("updateQueue"),
        QJsonObject{
            {QStringLiteral("queueId"), queueId},
            {QStringLiteral("queue"), QJsonObject::fromVariantMap(queue)},
        }
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

        applyQueueCatalog(controlResultObject(document.object())
            .value(QStringLiteral("queues")).toArray());
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
    if (!controlPlaneCommandSupported(QStringLiteral("deleteQueue"))) {
        emit requestFailed(QStringLiteral("Queue deletion is unavailable in this Runtime."));
        return;
    }

    auto *reply = postControlCommand(
        QStringLiteral("deleteQueue"),
        QJsonObject{{QStringLiteral("queueId"), queueId}}
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
        applyQueueCatalog(controlResultObject(document.object())
            .value(QStringLiteral("queues")).toArray());
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
    if (!controlPlaneCommandSupported(QStringLiteral("reorderQueues"))) {
        emit requestFailed(QStringLiteral("Queue reordering is unavailable in this Runtime."));
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
    auto *reply = postControlCommand(
        QStringLiteral("reorderQueues"),
        QJsonObject{{QStringLiteral("queueIds"), queueIds}}
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
        applyQueueCatalog(controlResultObject(document.object())
            .value(QStringLiteral("queues")).toArray());
        emit queueCatalogActionCompleted(QStringLiteral("reorder"), queueId);
    });
}

void NovaApiClient::moveTaskToQueue(const QString &taskIdText, const QString &queueIdText) {
    const QString taskId = taskIdText.trimmed();
    const QString queueId = queueIdText.trimmed();
    if (taskId.isEmpty() || queueId.isEmpty()) {
        return;
    }
    if (!controlPlaneCommandSupported(QStringLiteral("moveTask"))) {
        emit requestFailed(QStringLiteral("Moving tasks between queues is unavailable in this Runtime."));
        return;
    }

    auto *reply = postControlCommand(
        QStringLiteral("moveTask"),
        QJsonObject{
            {QStringLiteral("taskId"), taskId},
            {QStringLiteral("queueId"), queueId},
        }
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
        applyQueueCatalog(controlResultObject(document.object())
            .value(QStringLiteral("queues")).toArray());
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
    if (!controlPlaneCommandSupported(QStringLiteral("reorderQueueTasks"))) {
        emit requestFailed(QStringLiteral("Task ordering is unavailable in this Runtime."));
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
    auto *reply = postControlCommand(
        QStringLiteral("reorderQueueTasks"),
        QJsonObject{
            {QStringLiteral("queueId"), queueId},
            {QStringLiteral("taskIds"), order},
        }
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
        applyQueueCatalog(controlResultObject(document.object())
            .value(QStringLiteral("queues")).toArray());
        emit queueCatalogActionCompleted(QStringLiteral("reorder-task"), queueId);
        emit queueActionCompleted(taskId);
    });
}

void NovaApiClient::startQueue(const QString &queueIdText) {
    const QString queueId = queueIdText.trimmed();
    if (queueId.isEmpty()) {
        emit requestFailed(QStringLiteral("Queue was not found."));
        return;
    }
    if (!controlPlaneCommandSupported(QStringLiteral("startQueue"))) {
        emit requestFailed(QStringLiteral("Starting queues is unavailable in this Runtime."));
        return;
    }
    auto *reply = postControlCommand(
        QStringLiteral("startQueue"),
        QJsonObject{{QStringLiteral("queueId"), queueId}}
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
            emit requestFailed(QStringLiteral("Unexpected queue-start response."));
            return;
        }
        applyQueueCatalog(controlResultObject(document.object())
            .value(QStringLiteral("queues")).toArray());
        emit queueCatalogActionCompleted(QStringLiteral("start"), queueId);
        refreshDownloads();
        refreshQueue();
    });
}

void NovaApiClient::stopQueue(const QString &queueIdText) {
    const QString queueId = queueIdText.trimmed();
    if (queueId.isEmpty()) {
        return;
    }
    if (!controlPlaneCommandSupported(QStringLiteral("stopQueue"))) {
        emit requestFailed(QStringLiteral("Stopping queues is unavailable in this Runtime."));
        return;
    }
    auto *reply = postControlCommand(
        QStringLiteral("stopQueue"),
        QJsonObject{{QStringLiteral("queueId"), queueId}}
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
            emit requestFailed(QStringLiteral("Unexpected queue-stop response."));
            return;
        }
        applyQueueCatalog(controlResultObject(document.object())
            .value(QStringLiteral("queues")).toArray());
        emit queueCatalogActionCompleted(QStringLiteral("stop"), queueId);
        refreshDownloads();
        refreshQueue();
    });
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
    if (!controlPlaneCommandSupported(QStringLiteral("setTaskPriority"))) {
        emit requestFailed(QStringLiteral("Task priority changes are unavailable in this Runtime."));
        return;
    }
    auto *reply = postControlCommand(
        QStringLiteral("setTaskPriority"),
        QJsonObject{
            {QStringLiteral("taskId"), trimmedId},
            {QStringLiteral("priority"), qBound(0, priority, 4)},
        }
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
    auto *reply = postControlQuery(QStringLiteral("listSchedules"));
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

        const QJsonObject root = controlResultObject(document.object());
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
    if (!controlPlaneCommandSupported(QStringLiteral("setSchedulerPowerCommands"))) {
        emit requestFailed(QStringLiteral("Scheduler power actions are unavailable in this Runtime."));
        return;
    }
    auto *reply = postControlCommand(
        QStringLiteral("setSchedulerPowerCommands"),
        QJsonObject{{QStringLiteral("enabled"), enabled}}
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
    const QString &action
) {
    if (rule.value(QStringLiteral("id")).toString().trimmed().isEmpty()) {
        emit requestFailed(QStringLiteral("Scheduler rule id is required."));
        return;
    }

    const QString commandType = action == QStringLiteral("add")
        ? QStringLiteral("addSchedule")
        : QStringLiteral("updateSchedule");
    if (!controlPlaneCommandSupported(commandType)) {
        emit requestFailed(QStringLiteral("Scheduler rule changes are unavailable in this Runtime."));
        return;
    }
    auto *reply = postControlCommand(
        commandType,
        QJsonObject{{QStringLiteral("request"), rule}}
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

    if (!controlPlaneCommandSupported(QStringLiteral("deleteSchedule"))) {
        emit requestFailed(QStringLiteral("Deleting scheduler rules is unavailable in this Runtime."));
        return;
    }
    auto *reply = postControlCommand(
        QStringLiteral("deleteSchedule"),
        QJsonObject{{QStringLiteral("scheduleId"), trimmedId}}
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
    if (!controlPlaneCommandSupported(QStringLiteral("addDownload"))) {
        emit requestFailed(QStringLiteral("Direct downloads are unavailable in this Runtime."));
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

    constexpr qsizetype maxCommandsPerBatch = 128;
    QJsonArray commands;
    while (m_batchNextIndex < m_batchUrls.size() && commands.size() < maxCommandsPerBatch) {
        const QString urlText = m_batchUrls.at(m_batchNextIndex++);
        const QUrl url(urlText);
        QString fileName = QFileInfo(url.path()).fileName();
        if (fileName.isEmpty()) {
            fileName = QStringLiteral("download");
        }

        QJsonObject request;
        request.insert(QStringLiteral("url"), urlText);
        request.insert(QStringLiteral("name"), fileName);
        request.insert(QStringLiteral("fileType"), QStringLiteral("other"));
        request.insert(QStringLiteral("category"), QStringLiteral("other"));
        request.insert(QStringLiteral("queueId"), m_batchQueueId);
        request.insert(QStringLiteral("connections"), m_batchConnections);
        request.insert(QStringLiteral("resumable"), true);
        request.insert(QStringLiteral("description"), QStringLiteral("Native batch import"));
        request.insert(QStringLiteral("startImmediately"), m_batchStartImmediately);

        if (!m_batchSaveDirectory.isEmpty()) {
            request.insert(
                QStringLiteral("savePath"),
                QDir(m_batchSaveDirectory).filePath(fileName)
            );
        }
        if (!m_batchAdvancedOptions.isEmpty()) {
            request.insert(
                QStringLiteral("directOptions"),
                QJsonObject::fromVariantMap(m_batchAdvancedOptions)
            );
        }
        commands.append(QJsonObject{
            {QStringLiteral("type"), QStringLiteral("addDownload")},
            {QStringLiteral("request"), request},
        });
    }

    const int batchSize = static_cast<int>(commands.size());
    ++m_batchInFlight;
    auto *reply = postControlCommand(
        QStringLiteral("batch"),
        QJsonObject{
            {QStringLiteral("mode"), QStringLiteral("bestEffort")},
            {QStringLiteral("commands"), commands},
        }
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply, batchSize]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();

        --m_batchInFlight;
        if (reply->error() == QNetworkReply::NoError) {
            const QJsonDocument document = QJsonDocument::fromJson(payload);
            if (document.isObject()) {
                const QJsonObject result = document.object().value(QStringLiteral("result")).toObject();
                const int succeeded = result.value(QStringLiteral("succeeded")).toInt(-1);
                const int failed = result.value(QStringLiteral("failed")).toInt(-1);
                if (succeeded >= 0 && failed >= 0 && succeeded + failed == batchSize) {
                    m_batchAccepted += succeeded;
                    m_batchFailed += failed;
                } else {
                    m_batchFailed += batchSize;
                }
            } else {
                m_batchFailed += batchSize;
            }
        } else {
            m_batchFailed += batchSize;
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
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/media/probe"), query));

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

        QSet<QString> seenFormatIds;
        const QJsonArray parsedFormats = root.value(QStringLiteral("formats")).toArray();
        for (const QJsonValue &value : parsedFormats) {
            const QJsonObject format = value.toObject();
            const QString formatId = format.value(QStringLiteral("formatId")).toString();
            if (formatId.isEmpty() || seenFormatIds.contains(formatId)) {
                continue;
            }
            seenFormatIds.insert(formatId);

            QVariantMap item;
            item.insert(QStringLiteral("formatId"), formatId);
            item.insert(QStringLiteral("height"), format.value(QStringLiteral("height")).toInt());
            item.insert(QStringLiteral("width"), format.value(QStringLiteral("width")).toInt());
            item.insert(QStringLiteral("ext"), format.value(QStringLiteral("ext")).toString());
            item.insert(QStringLiteral("filesize"), format.value(QStringLiteral("filesize")).toInteger());
            item.insert(QStringLiteral("vcodec"), format.value(QStringLiteral("vcodec")).toString());
            item.insert(QStringLiteral("acodec"), format.value(QStringLiteral("acodec")).toString());
            item.insert(QStringLiteral("hasVideo"), format.value(QStringLiteral("hasVideo")).toBool());
            item.insert(QStringLiteral("hasAudio"), format.value(QStringLiteral("hasAudio")).toBool());
            item.insert(QStringLiteral("fps"), format.value(QStringLiteral("fps")).toDouble());
            item.insert(QStringLiteral("tbr"), format.value(QStringLiteral("tbr")).toDouble());
            item.insert(QStringLiteral("formatNote"), format.value(QStringLiteral("formatNote")).toString());
            m_mediaFormats.append(item);
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
    auto *reply = m_network.get(makeRequest(QStringLiteral("/api/media/probe-playlist"), query));

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

void NovaApiClient::createMediaDownload(
    const QString &urlText,
    const QString &nameText,
    const QString &saveDirectory,
    const QVariantMap &mediaOptions,
    bool startImmediately
) {
    const bool playlistRequest = mediaOptions.value(QStringLiteral("playlist")).toBool();
    const QString capabilityId = playlistRequest
        ? QStringLiteral("addMediaPlaylist")
        : QStringLiteral("addMediaDownload");
    if (!controlPlaneCommandSupported(capabilityId)) {
        emit requestFailed(QStringLiteral("The Runtime does not report this media operation as available."));
        return;
    }
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

    if (m_engineCapabilities.contains(QStringLiteral("mediaExtractionReady"))
        && !m_engineCapabilities.value(QStringLiteral("mediaExtractionReady")).toBool()) {
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
    const bool playlistBatch = options.value(QStringLiteral("playlist")).toBool();

    const QString directory = saveDirectory.trimmed();
    if (!directory.isEmpty()) {
        body.insert(
            QStringLiteral("savePath"),
            QDir(directory).absolutePath() + QDir::separator()
        );
    }

    auto *reply = postControlCommand(
        playlistBatch ? QStringLiteral("addMediaPlaylist") : QStringLiteral("addMediaDownload"),
        QJsonObject{{QStringLiteral("request"), body}}
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply, playlistBatch]() {
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

        const QJsonObject result = document.object().value(QStringLiteral("result")).toObject();
        if (playlistBatch) {
            const int accepted = result.value(QStringLiteral("accepted")).toInt();
            const int failed = result.value(QStringLiteral("failed")).toInt();
            QStringList failureMessages;
            const QJsonArray failures = result.value(QStringLiteral("failures")).toArray();
            for (qsizetype index = 0; index < failures.size() && index < 3; ++index) {
                const QJsonObject failure = failures.at(index).toObject();
                const QString title = failure.value(QStringLiteral("title")).toString();
                const QString error = failure.value(QStringLiteral("error")).toString();
                failureMessages.append(title.isEmpty() ? error : title + QStringLiteral(": ") + error);
            }
            emit mediaPlaylistDownloadsCreated(accepted, failed, failureMessages.join(QLatin1Char('\n')));
            refreshDownloads();
            refreshQueue();
            return;
        }

        const QString taskId = result.value(QStringLiteral("id")).toString();
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
    auto *reply = postControlQuery(QStringLiteral("listProfiles"));
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

        const QJsonObject root = controlResultObject(document.object());
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
    if (!controlPlaneCommandSupported(QStringLiteral("setActiveProfile"))) {
        emit engineManagementFailed(QStringLiteral("Changing the active profile is unavailable in this Runtime."));
        return;
    }
    auto *reply = postControlCommand(
        QStringLiteral("setActiveProfile"),
        QJsonObject{{QStringLiteral("profileId"), id}}
    );

    connect(reply, &QNetworkReply::finished, this, [this, reply, id]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit engineManagementFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()
            || !controlResultObject(document.object()).value(QStringLiteral("ok")).toBool()) {
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

void NovaApiClient::refreshCaptureReviews() {
    if (!m_connected || m_captureReviewsRequestInFlight) {
        return;
    }

    m_captureReviewsRequestInFlight = true;
    auto *reply = m_network.get(makeRequest(QStringLiteral("/v1/capture-reviews")));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        m_captureReviewsRequestInFlight = false;

        if (reply->error() != QNetworkReply::NoError) {
            emit captureReviewListFailed(responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()
            || !document.object().value(QStringLiteral("reviews")).isArray()) {
            emit captureReviewListFailed(
                QStringLiteral("Unexpected browser capture review response.")
            );
            return;
        }

        m_captureReviews = document.object()
            .value(QStringLiteral("reviews"))
            .toArray()
            .toVariantList();
        emit captureReviewsChanged();
    });
}

void NovaApiClient::consumeCaptureReview(
    const QString &reviewId,
    const QString &name,
    const QString &savePath,
    bool startImmediately,
    int connections
) {
    const QString trimmedId = reviewId.trimmed();
    if (!m_connected || trimmedId.isEmpty()) {
        emit captureReviewActionFailed(
            trimmedId,
            QStringLiteral("NOVA is not connected to the daemon.")
        );
        return;
    }

    QJsonObject body;
    const QString trimmedName = name.trimmed();
    const QString trimmedPath = savePath.trimmed();
    if (!trimmedName.isEmpty()) {
        body.insert(QStringLiteral("name"), trimmedName);
    }
    if (!trimmedPath.isEmpty()) {
        body.insert(QStringLiteral("savePath"), trimmedPath);
    }
    body.insert(QStringLiteral("startImmediately"), startImmediately);
    body.insert(QStringLiteral("connections"), qBound(0, connections, 32));

    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(trimmedId));
    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/v1/capture-reviews/%1/consume").arg(encodedId)),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply, trimmedId]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit captureReviewActionFailed(
                trimmedId,
                responseErrorMessage(reply, payload)
            );
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()
            || !document.object().value(QStringLiteral("accepted")).toBool()) {
            emit captureReviewActionFailed(
                trimmedId,
                document.isObject()
                    ? document.object().value(QStringLiteral("message")).toString()
                    : QStringLiteral("Unexpected capture review response.")
            );
            return;
        }

        const QJsonObject response = document.object();
        const QString taskId = response.value(QStringLiteral("taskId")).toString(
            response.value(QStringLiteral("task")).toObject()
                .value(QStringLiteral("id")).toString()
        );
        emit captureReviewConsumed(trimmedId, taskId);
        refreshCaptureReviews();
        refreshDownloads();
    });
}

void NovaApiClient::discardCaptureReview(const QString &reviewId) {
    const QString trimmedId = reviewId.trimmed();
    if (!m_connected || trimmedId.isEmpty()) {
        emit captureReviewActionFailed(
            trimmedId,
            QStringLiteral("NOVA is not connected to the daemon.")
        );
        return;
    }

    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(trimmedId));
    auto *reply = m_network.sendCustomRequest(
        makeRequest(QStringLiteral("/v1/capture-reviews/%1").arg(encodedId)),
        QByteArrayLiteral("DELETE")
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply, trimmedId]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit captureReviewActionFailed(
                trimmedId,
                responseErrorMessage(reply, payload)
            );
            return;
        }

        m_captureReviews.erase(
            std::remove_if(
                m_captureReviews.begin(),
                m_captureReviews.end(),
                [&trimmedId](const QVariant &value) {
                    return value.toMap().value(QStringLiteral("reviewId")).toString()
                        == trimmedId;
                }
            ),
            m_captureReviews.end()
        );
        emit captureReviewsChanged();
        emit captureReviewDiscarded(trimmedId);
    });
}

void NovaApiClient::sendTorrentAnalysis(
    const QString &path,
    const QByteArray &payload,
    const QByteArray &contentType
) {
    if (!m_connected) {
        emit torrentAnalysisFailed(QStringLiteral("NOVA is not connected to the daemon."));
        return;
    }
    if (m_torrentAnalysisBusy) {
        return;
    }

    m_torrentAnalysisBusy = true;
    m_torrentAnalysis.clear();
    emit torrentAnalysisChanged();

    QNetworkRequest request = makeRequest(path);
    request.setHeader(
        QNetworkRequest::ContentTypeHeader,
        QString::fromLatin1(contentType)
    );
    auto *reply = m_network.post(request, payload);
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray responseBody = reply->readAll();
        m_torrentAnalysisBusy = false;

        if (reply->error() != QNetworkReply::NoError) {
            emit torrentAnalysisChanged();
            emit torrentAnalysisFailed(responseErrorMessage(reply, responseBody));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(responseBody);
        if (!document.isObject()) {
            emit torrentAnalysisChanged();
            emit torrentAnalysisFailed(QStringLiteral("Unexpected torrent analysis response."));
            return;
        }
        const QJsonObject response = document.object();
        if (response.contains(QStringLiteral("ok"))
            && !response.value(QStringLiteral("ok")).toBool()) {
            emit torrentAnalysisChanged();
            emit torrentAnalysisFailed(
                response.value(QStringLiteral("message")).toString(
                    QStringLiteral("Torrent analysis failed.")
                )
            );
            return;
        }
        if (response.value(QStringLiteral("analysisId")).toString().isEmpty()
            || !response.value(QStringLiteral("files")).isArray()) {
            emit torrentAnalysisChanged();
            emit torrentAnalysisFailed(QStringLiteral("Torrent analysis response is incomplete."));
            return;
        }

        m_torrentAnalysis = response.toVariantMap();
        emit torrentAnalysisChanged();
    });
}

void NovaApiClient::clearTorrentAnalysis() {
    if (m_torrentAnalysis.isEmpty()) {
        return;
    }
    m_torrentAnalysis.clear();
    emit torrentAnalysisChanged();
}

void NovaApiClient::clearTorrentDetails() {
    ++m_torrentDetailsGeneration;
    if (!m_torrentDetailsBusy && m_torrentDetailsTaskId.isEmpty()
        && m_torrentDetails.isEmpty()) {
        return;
    }
    m_torrentDetailsBusy = false;
    m_torrentDetailsTaskId.clear();
    m_torrentDetails.clear();
    emit torrentDetailsChanged();
}

void NovaApiClient::refreshTorrentDetails(const QString &taskId) {
    const QString id = taskId.trimmed();
    if (id.isEmpty() || !m_connected) {
        clearTorrentDetails();
        return;
    }
    if (m_torrentDetailsBusy && m_torrentDetailsTaskId == id) {
        return;
    }

    if (m_torrentDetailsTaskId != id) {
        m_torrentDetails.clear();
    }
    m_torrentDetailsTaskId = id;
    m_torrentDetailsBusy = true;
    const quint64 generation = ++m_torrentDetailsGeneration;
    emit torrentDetailsChanged();

    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(id));
    auto *reply = m_network.get(
        makeRequest(QStringLiteral("/api/torrents/%1").arg(encodedId))
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply, id, generation]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (generation != m_torrentDetailsGeneration
            || id != m_torrentDetailsTaskId) {
            return;
        }

        m_torrentDetailsBusy = false;
        if (reply->error() != QNetworkReply::NoError) {
            emit torrentDetailsChanged();
            emit torrentDetailsFailed(id, responseErrorMessage(reply, payload));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()
            || !document.object().value(QStringLiteral("task")).isObject()
            || !document.object().value(QStringLiteral("files")).isArray()) {
            emit torrentDetailsChanged();
            emit torrentDetailsFailed(id, QStringLiteral("Unexpected torrent details response."));
            return;
        }

        m_torrentDetails = document.object().toVariantMap();
        m_torrentDetails.insert(QStringLiteral("taskId"), id);
        emit torrentDetailsChanged();
    });
}

void NovaApiClient::updateTorrentFilePriorities(
    const QString &taskId,
    const QVariantList &filePriorities
) {
    const QString id = taskId.trimmed();
    if (id.isEmpty() || filePriorities.isEmpty()) {
        emit torrentDetailsActionFailed(
            id,
            QStringLiteral("Choose at least one torrent file.")
        );
        return;
    }

    QJsonArray priorities;
    for (const QVariant &priority : filePriorities) {
        const QString value = priority.toString();
        if (value != QStringLiteral("high")
            && value != QStringLiteral("normal")
            && value != QStringLiteral("skip")) {
            emit torrentDetailsActionFailed(
                id,
                QStringLiteral("A torrent file priority is invalid.")
            );
            return;
        }
        priorities.append(value);
    }

    QJsonObject body;
    body.insert(QStringLiteral("filePriorities"), priorities);
    sendTorrentDetailsUpdate(
        id,
        QStringLiteral("files"),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );
}

void NovaApiClient::updateTorrentSeedingPolicy(
    const QString &taskId,
    const QVariantMap &policy
) {
    const QString id = taskId.trimmed();
    if (id.isEmpty() || !policy.contains(QStringLiteral("enabled"))) {
        emit torrentDetailsActionFailed(
            id,
            QStringLiteral("A valid torrent seeding policy is required.")
        );
        return;
    }

    sendTorrentDetailsUpdate(
        id,
        QStringLiteral("seeding"),
        QJsonDocument(QJsonObject::fromVariantMap(policy))
            .toJson(QJsonDocument::Compact)
    );
}

void NovaApiClient::reauthorizeTorrentTask(
    const QString &taskId,
    const QString &magnetUri
) {
    const QString id = taskId.trimmed();
    const QString magnet = magnetUri.trimmed();
    if (!m_connected || id.isEmpty() || !magnet.startsWith(QStringLiteral("magnet:"), Qt::CaseInsensitive)) {
        emit torrentDetailsActionFailed(
            id,
            QStringLiteral("Enter a tracker magnet link for this torrent.")
        );
        return;
    }

    QJsonObject body;
    body.insert(QStringLiteral("magnetUri"), magnet);
    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(id));
    auto *reply = m_network.post(
        makeRequest(QStringLiteral("/api/torrents/%1/reauthorize").arg(encodedId)),
        QJsonDocument(body).toJson(QJsonDocument::Compact)
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply, id]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit torrentDetailsActionFailed(id, responseErrorMessage(reply, payload));
            return;
        }
        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isObject()
            || document.object().value(QStringLiteral("id")).toString() != id) {
            emit torrentDetailsActionFailed(
                id,
                QStringLiteral("Unexpected torrent authorization response.")
            );
            return;
        }
        emit torrentDetailsActionCompleted(QStringLiteral("reauthorize"), id);
        refreshDownloads();
        if (m_torrentDetailsTaskId == id)
            refreshTorrentDetails(id);
    });
}

void NovaApiClient::sendTorrentDetailsUpdate(
    const QString &taskId,
    const QString &action,
    const QByteArray &payload
) {
    if (!m_connected) {
        emit torrentDetailsActionFailed(
            taskId,
            QStringLiteral("NOVA is not connected to the daemon.")
        );
        return;
    }

    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(taskId));
    QNetworkRequest request = makeRequest(
        QStringLiteral("/api/torrents/%1/%2").arg(encodedId, action)
    );
    request.setHeader(
        QNetworkRequest::ContentTypeHeader,
        QStringLiteral("application/json")
    );
    auto *payloadBuffer = new QBuffer(this);
    payloadBuffer->setData(payload);
    payloadBuffer->open(QIODevice::ReadOnly);
    auto *reply = m_network.sendCustomRequest(
        request,
        QByteArrayLiteral("PATCH"),
        payloadBuffer
    );
    connect(reply, &QNetworkReply::finished, this, [this, reply, payloadBuffer, taskId, action]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        payloadBuffer->deleteLater();
        const QByteArray responseBody = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit torrentDetailsActionFailed(
                taskId,
                responseErrorMessage(reply, responseBody)
            );
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(responseBody);
        if (!document.isObject()
            || !document.object().value(QStringLiteral("task")).isObject()
            || !document.object().value(QStringLiteral("files")).isArray()) {
            emit torrentDetailsActionFailed(
                taskId,
                QStringLiteral("Unexpected torrent update response.")
            );
            return;
        }

        if (m_torrentDetailsTaskId == taskId) {
            m_torrentDetails = document.object().toVariantMap();
            m_torrentDetails.insert(QStringLiteral("taskId"), taskId);
            emit torrentDetailsChanged();
        }
        emit torrentDetailsActionCompleted(action, taskId);
        refreshDownloads();
    });
}

void NovaApiClient::analyzeTorrentMagnet(const QString &magnetUri) {
    const QString uri = magnetUri.trimmed();
    if (!uri.startsWith(QStringLiteral("magnet:"), Qt::CaseInsensitive)) {
        emit torrentAnalysisFailed(QStringLiteral("Enter a valid magnet URI."));
        return;
    }
    QJsonObject body;
    body.insert(QStringLiteral("magnetUri"), uri);
    sendTorrentAnalysis(
        QStringLiteral("/api/torrents/analyze"),
        QJsonDocument(body).toJson(QJsonDocument::Compact),
        QByteArrayLiteral("application/json")
    );
}

void NovaApiClient::analyzeTorrentUrl(const QString &url) {
    const QString source = url.trimmed();
    if (source.isEmpty()) {
        emit torrentAnalysisFailed(QStringLiteral("Enter an HTTP(S) .torrent URL."));
        return;
    }
    QJsonObject body;
    body.insert(QStringLiteral("url"), source);
    sendTorrentAnalysis(
        QStringLiteral("/api/torrents/analyze-url"),
        QJsonDocument(body).toJson(QJsonDocument::Compact),
        QByteArrayLiteral("application/json")
    );
}

void NovaApiClient::analyzeTorrentFile(const QString &path) {
    QFile file(path.trimmed());
    if (!file.open(QIODevice::ReadOnly)) {
        emit torrentAnalysisFailed(QStringLiteral("NOVA could not read the selected .torrent file."));
        return;
    }
    constexpr qint64 maxMetainfoBytes = 32LL * 1024LL * 1024LL;
    if (file.size() <= 0 || file.size() > maxMetainfoBytes) {
        emit torrentAnalysisFailed(QStringLiteral("The .torrent file must be between 1 byte and 32 MiB."));
        return;
    }
    const QByteArray bytes = file.read(maxMetainfoBytes + 1);
    if (file.error() != QFileDevice::NoError
        || bytes.size() != file.size()
        || bytes.size() > maxMetainfoBytes) {
        emit torrentAnalysisFailed(QStringLiteral("NOVA could not read the complete .torrent file."));
        return;
    }
    sendTorrentAnalysis(
        QStringLiteral("/api/torrents/analyze-file"),
        bytes,
        QByteArrayLiteral("application/x-bittorrent")
    );
}

void NovaApiClient::analyzeCaptureReviewTorrent(const QString &reviewId) {
    const QString id = reviewId.trimmed();
    if (id.isEmpty()) {
        emit torrentAnalysisFailed(QStringLiteral("The browser torrent review is no longer available."));
        return;
    }
    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(id));
    sendTorrentAnalysis(
        QStringLiteral("/v1/capture-reviews/%1/analyze-torrent").arg(encodedId),
        QByteArrayLiteral("{}"),
        QByteArrayLiteral("application/json")
    );
}

void NovaApiClient::createTorrent(
    const QString &analysisId,
    const QString &savePath,
    bool startImmediately,
    const QVariantList &filePriorities,
    int connections,
    const QVariantMap &seeding,
    bool allowDuplicate,
    const QString &captureReviewId
) {
    if (!controlPlaneCommandSupported(QStringLiteral("addTorrent"))) {
        emit torrentTaskCreationFailed(QStringLiteral("Torrent creation is unavailable in this Runtime."));
        return;
    }
    const QString trimmedAnalysisId = analysisId.trimmed();
    const QString trimmedPath = savePath.trimmed();
    if (!m_connected || trimmedAnalysisId.isEmpty() || trimmedPath.isEmpty()) {
        emit torrentTaskCreationFailed(
            QStringLiteral("Choose a destination and analyze the torrent before adding it.")
        );
        return;
    }

    QJsonArray priorities;
    for (const QVariant &priority : filePriorities) {
        priorities.append(priority.toString());
    }

    QJsonObject body;
    body.insert(QStringLiteral("analysisId"), trimmedAnalysisId);
    body.insert(QStringLiteral("savePath"), trimmedPath);
    body.insert(QStringLiteral("startImmediately"), startImmediately);
    body.insert(QStringLiteral("filePriorities"), priorities);
    body.insert(QStringLiteral("connections"), qBound(1, connections, 32));
    body.insert(QStringLiteral("seeding"), QJsonObject::fromVariantMap(seeding));
    body.insert(QStringLiteral("allowDuplicate"), allowDuplicate);

    const QString id = captureReviewId.trimmed();
    QNetworkReply *reply = nullptr;
    if (id.isEmpty()) {
        reply = postControlCommand(
            QStringLiteral("addTorrent"),
            QJsonObject{{QStringLiteral("request"), body}}
        );
    } else {
        const QString route = QStringLiteral("/v1/capture-reviews/%1/consume-torrent")
            .arg(QString::fromUtf8(QUrl::toPercentEncoding(id)));
        reply = m_network.post(
            makeRequest(route),
            QJsonDocument(body).toJson(QJsonDocument::Compact)
        );
    }
    connect(reply, &QNetworkReply::finished, this, [this, reply, id]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray responseBody = reply->readAll();
        if (reply->error() != QNetworkReply::NoError) {
            emit torrentTaskCreationFailed(responseErrorMessage(reply, responseBody));
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(responseBody);
        if (!document.isObject()) {
            emit torrentTaskCreationFailed(QStringLiteral("Unexpected torrent task response."));
            return;
        }
        const QJsonObject response = id.isEmpty()
            ? document.object().value(QStringLiteral("result")).toObject()
            : document.object();
        if (!id.isEmpty() && !response.value(QStringLiteral("accepted")).toBool()) {
            emit torrentTaskCreationFailed(
                response.value(QStringLiteral("message")).toString(
                    QStringLiteral("NOVA could not approve the torrent capture.")
                )
            );
            return;
        }
        const QString taskId = response.value(QStringLiteral("id")).toString(
            response.value(QStringLiteral("taskId")).toString(
                response.value(QStringLiteral("task")).toObject()
                    .value(QStringLiteral("id")).toString()
            )
        );
        if (taskId.isEmpty()) {
            emit torrentTaskCreationFailed(QStringLiteral("NOVA did not return the created torrent task."));
            return;
        }

        emit torrentTaskCreated(taskId);
        refreshDownloads();
        if (!id.isEmpty()) {
            refreshCaptureReviews();
        }
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
