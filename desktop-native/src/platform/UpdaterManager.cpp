#include "platform/UpdaterManager.h"

#include <QCoreApplication>
#include <QDesktopServices>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QScopeGuard>
#include <QVersionNumber>

UpdaterManager::UpdaterManager(QObject *parent)
    : QObject(parent) {}

QString UpdaterManager::currentVersion() const {
    const QString version = QCoreApplication::applicationVersion().trimmed();
    return version.isEmpty() ? QStringLiteral("unknown") : version;
}

QString UpdaterManager::normalizeVersion(const QString &version) {
    QString normalized = version.trimmed();
    if (normalized.startsWith(QLatin1Char('v'), Qt::CaseInsensitive)) {
        normalized.remove(0, 1);
    }
    return normalized;
}

bool UpdaterManager::isNewerVersion(
    const QString &candidate,
    bool candidatePrerelease,
    const QString &current
) {
    const QString candidateText = normalizeVersion(candidate);
    const QString currentText = normalizeVersion(current);

    const QVersionNumber candidateNumber = QVersionNumber::fromString(candidateText);
    const QVersionNumber currentNumber = QVersionNumber::fromString(currentText);

    const int comparison = QVersionNumber::compare(candidateNumber, currentNumber);
    if (comparison != 0) {
        return comparison > 0;
    }

    const bool currentPrerelease = currentText.contains(QLatin1Char('-'));
    if (currentPrerelease != candidatePrerelease) {
        return currentPrerelease && !candidatePrerelease;
    }

    return false;
}

void UpdaterManager::checkForUpdates(const QString &channelText) {
    if (m_busy) {
        return;
    }

    const QString channel = channelText.trimmed().toLower() == QStringLiteral("preview")
        ? QStringLiteral("preview")
        : QStringLiteral("stable");

    m_busy = true;
    m_updateAvailable = false;
    m_latestVersion.clear();
    m_releaseUrl.clear();
    m_statusText = QStringLiteral("Checking for updates…");
    emit stateChanged();

    QNetworkRequest request{
        QUrl(QStringLiteral(
            "https://api.github.com/repos/Alaa91H/NOVADownloadManager/releases?per_page=20"
        ))
    };
    request.setRawHeader("Accept", "application/vnd.github+json");
    request.setRawHeader("User-Agent", "NOVA-Download-Manager-Native");
    request.setTransferTimeout(15000);

    auto *reply = m_network.get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply, channel]() {
        const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
        const QByteArray payload = reply->readAll();
        m_busy = false;

        if (reply->error() != QNetworkReply::NoError) {
            m_statusText = QStringLiteral("Update check failed");
            emit stateChanged();
            emit updateCheckFailed(reply->errorString());
            return;
        }

        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (!document.isArray()) {
            m_statusText = QStringLiteral("Unexpected update response");
            emit stateChanged();
            emit updateCheckFailed(m_statusText);
            return;
        }

        QJsonObject selected;
        for (const QJsonValue &value : document.array()) {
            const QJsonObject release = value.toObject();
            if (release.value(QStringLiteral("draft")).toBool()) {
                continue;
            }

            const bool prerelease = release.value(QStringLiteral("prerelease")).toBool();
            if (channel == QStringLiteral("stable") && prerelease) {
                continue;
            }

            selected = release;
            break;
        }

        if (selected.isEmpty()) {
            m_statusText = channel == QStringLiteral("preview")
                ? QStringLiteral("No published releases found")
                : QStringLiteral("No stable release found");
            emit stateChanged();
            return;
        }

        m_latestVersion = normalizeVersion(
            selected.value(QStringLiteral("tag_name")).toString()
        );
        m_releaseUrl = QUrl(
            selected.value(QStringLiteral("html_url")).toString()
        );
        const bool prerelease = selected.value(QStringLiteral("prerelease")).toBool();

        m_updateAvailable = isNewerVersion(
            m_latestVersion,
            prerelease,
            currentVersion()
        );
        m_statusText = m_updateAvailable
            ? QStringLiteral("Update available")
            : QStringLiteral("Up to date");
        emit stateChanged();
    });
}

bool UpdaterManager::openReleasePage() {
    if (!m_releaseUrl.isValid() || m_releaseUrl.isEmpty()) {
        return false;
    }
    return QDesktopServices::openUrl(m_releaseUrl);
}
