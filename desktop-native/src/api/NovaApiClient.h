#pragma once

#include <QJsonArray>
#include <QNetworkAccessManager>
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

signals:
    void connectionChanged();
    void downloadsLoaded(const QJsonArray &downloads);
    void requestFailed(const QString &message);

private:
    QNetworkRequest makeRequest(const QString &path) const;
    void setConnectionState(bool connected, const QString &text);

    QNetworkAccessManager m_network;
    QUrl m_baseUrl{QStringLiteral("http://127.0.0.1:3199")};
    QString m_bearerToken;
    bool m_connected{false};
    QString m_statusText{QStringLiteral("Connecting…")};
};
