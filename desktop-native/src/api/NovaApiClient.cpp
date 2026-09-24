#include "api/NovaApiClient.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>\n#include <QHash>\n#include <QSet>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QScopeGuard>
#include <QTimer>
#include <QUrl>

NovaApiClient::NovaApiClient(QObject *parent)
    : QObject(parent) {}

void NovaApiClient::setBaseUrl(const QUrl &baseUrl) {
    if (baseUrl.isValid() && !baseUrl.isEmpty()) {
        m_baseUrl = baseUrl;
    }
}

void NovaApiClient::setBearerToken(const QString &token) {
    m_bearerToken = token.trimmed();
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

        if (reply->error() != QNetworkReply::NoError) {
            setConnectionState(false, QStringLiteral("Engine unavailable"));
            emit requestFailed(reply->errorString());
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(reply->readAll());
        const QJsonObject root = document.object();
        const QString status = root.value(QStringLiteral("status")).toString();
        const bool healthy = status == QStringLiteral("connected") || status == QStringLiteral("degraded");
        setConnectionState(healthy, healthy ? QStringLiteral("Engine ready") : QStringLiteral("Engine unavailable"));
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
        emit downloadsLoaded(m_currentDownloads);
    });
}

void NovaApiClient::startDownloadStream() {
    if (m_streamReply) {
        return;
    }

    QNetworkRequest request = makeRequest(QStringLiteral("/api/downloads/events"));
    request.setRawHeader("Accept", "text/event-stream");
    m_streamReply = m_network.get(request);

    connect(m_streamReply, &QNetworkReply::readyRead, this, &NovaApiClient::processStreamChunk);
    connect(m_streamReply, &QNetworkReply::finished, this, [this]() {
        if (!m_streamReply) {
            return;
        }

        const QString errorText = m_streamReply->error() == QNetworkReply::NoError
            ? QStringLiteral("Live updates disconnected")
            : m_streamReply->errorString();

        m_streamReply->deleteLater();
        m_streamReply = nullptr;
        m_streamBuffer.clear();

        emit requestFailed(errorText);
        QTimer::singleShot(1500, this, &NovaApiClient::startDownloadStream);
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
        m_currentDownloads = document.array();
        emit downloadsLoaded(m_currentDownloads);
        return;
    }

    if (eventName == "downloads-delta" && document.isObject()) {
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
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(reply->errorString());
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

void NovaApiClient::deleteDownload(const QString &id) {
    if (id.isEmpty()) {
        return;
    }

    const QString encodedId = QString::fromUtf8(QUrl::toPercentEncoding(id));
    auto *reply = m_network.deleteResource(makeRequest(QStringLiteral("/api/downloads/%1").arg(encodedId)));

    connect(reply, &QNetworkReply::finished, this, [this, reply, id]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        if (reply->error() != QNetworkReply::NoError) {
            emit requestFailed(reply->errorString());
            return;
        }
        emit taskActionCompleted(QStringLiteral("delete"), id);
        refreshDownloads();
    });
}
