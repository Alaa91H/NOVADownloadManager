#include "platform/BackendBootstrap.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcessEnvironment>
#include <QScopeGuard>
#include <QStringList>

namespace {
constexpr int kFirstPort = 3199;
constexpr int kLastPort = 3229;
constexpr int kMaxProbeRounds = 40;
constexpr int kRetryDelayMs = 150;
constexpr int kProbeTimeoutMs = 750;

QString nativeDataDirectory() {
    const QString overrideDirectory = qEnvironmentVariable("NOVA_NATIVE_DATA_DIR").trimmed();
    if (!overrideDirectory.isEmpty()) {
        return overrideDirectory;
    }

#if defined(Q_OS_WIN)
    const QString appData = qEnvironmentVariable("APPDATA").trimmed();
    if (!appData.isEmpty()) {
        return QDir(appData).filePath(QStringLiteral("com.nova.downloadmanager"));
    }
#elif defined(Q_OS_MACOS)
    const QString home = QDir::homePath();
    if (!home.isEmpty()) {
        return QDir(home).filePath(
            QStringLiteral("Library/Application Support/com.nova.downloadmanager")
        );
    }
#else
    const QString xdgDataHome = qEnvironmentVariable("XDG_DATA_HOME").trimmed();
    if (!xdgDataHome.isEmpty()) {
        return QDir(xdgDataHome).filePath(QStringLiteral("com.nova.downloadmanager"));
    }

    const QString home = QDir::homePath();
    if (!home.isEmpty()) {
        return QDir(home).filePath(
            QStringLiteral(".local/share/com.nova.downloadmanager")
        );
    }
#endif

    return {};
}
}

BackendBootstrap::BackendBootstrap(QObject *parent)
    : QObject(parent) {
    m_retryTimer.setSingleShot(true);
    connect(&m_retryTimer, &QTimer::timeout, this, &BackendBootstrap::beginProbeRound);

    connect(
        &m_backendProcess,
        &QProcess::errorOccurred,
        this,
        [this](QProcess::ProcessError error) {
            if (m_shuttingDown || error == QProcess::Crashed) {
                return;
            }
            setStatus(QStringLiteral("NOVA backend could not be started."));
        }
    );
    connect(
        &m_backendProcess,
        qOverload<int, QProcess::ExitStatus>(&QProcess::finished),
        this,
        [this](int, QProcess::ExitStatus) {
            const bool ownedBackend = m_startedBackend;
            m_startedBackend = false;
            if (!m_shuttingDown && ownedBackend) {
                recover();
            }
        }
    );
}

BackendBootstrap::~BackendBootstrap() {
    m_shuttingDown = true;
    if (m_startedBackend && m_backendProcess.state() != QProcess::NotRunning) {
        m_backendProcess.terminate();
        if (!m_backendProcess.waitForFinished(1200)) {
            m_backendProcess.kill();
            m_backendProcess.waitForFinished(500);
        }
    }
}

void BackendBootstrap::setStatus(const QString &text) {
    if (m_statusText == text) {
        return;
    }
    m_statusText = text;
    emit stateChanged();
}

void BackendBootstrap::start() {
    if (m_ready || m_retryTimer.isActive()) {
        return;
    }

    m_round = 0;
    m_nextPort = kFirstPort;
    setStatus(QStringLiteral("Discovering NOVA engine…"));
    beginProbeRound();
}

void BackendBootstrap::recover() {
    if (m_shuttingDown) {
        return;
    }

    if (m_ready) {
        m_ready = false;
        emit stateChanged();
    }

    m_round = 0;
    m_nextPort = kFirstPort;
    setStatus(QStringLiteral("Recovering NOVA engine…"));

    if (!m_retryTimer.isActive()) {
        m_retryTimer.start(kRetryDelayMs);
    }
}

void BackendBootstrap::beginProbeRound() {
    if (m_ready) {
        return;
    }

    m_nextPort = kFirstPort;
    ++m_round;
    probeNextPort();
}

void BackendBootstrap::probeNextPort() {
    if (m_ready) {
        return;
    }

    if (m_nextPort > kLastPort) {
        if (!m_startedBackend) {
            if (!launchBundledBackend()) {
                const QString message = QStringLiteral(
                    "Bundled NOVA backend is missing or could not be started."
                );
                setStatus(message);
                emit bootstrapFailed(message);
                return;
            }
            setStatus(QStringLiteral("Starting NOVA engine…"));
        }

        if (m_round >= kMaxProbeRounds) {
            const QString message = QStringLiteral(
                "NOVA engine did not become ready in time."
            );
            setStatus(message);
            emit bootstrapFailed(message);
            return;
        }

        m_retryTimer.start(kRetryDelayMs);
        return;
    }

    const int port = m_nextPort++;
    const QString pairingSecret = pairingSecretForPort(port);
    if (pairingSecret.isEmpty()) {
        probeNextPort();
        return;
    }

    const QUrl baseUrl(QStringLiteral("http://127.0.0.1:%1").arg(port));
    QNetworkRequest request(baseUrl.resolved(QUrl(QStringLiteral("/v1/pair/auto"))));
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setRawHeader("Accept", "application/json");
    request.setRawHeader("x-nova-native-desktop", "1");
    request.setRawHeader("x-nova-pairing-secret", pairingSecret.toUtf8());
    request.setTransferTimeout(kProbeTimeoutMs);

    auto *reply = m_network.post(request, QByteArrayLiteral("{}"));
    connect(reply, &QNetworkReply::finished, this, [this, reply, baseUrl]() {
        handleProbeReply(reply, baseUrl);
    });
}

void BackendBootstrap::handleProbeReply(QNetworkReply *reply, const QUrl &baseUrl) {
    const auto guard = qScopeGuard([reply]() { reply->deleteLater(); });
    const QByteArray payload = reply->readAll();

    if (reply->error() == QNetworkReply::NoError) {
        const QJsonDocument document = QJsonDocument::fromJson(payload);
        if (document.isObject()) {
            const QJsonObject object = document.object();
            const QString token = object.value(QStringLiteral("pairToken")).toString();
            const bool approved = object.value(QStringLiteral("autoApproved")).toBool(false);
            if (!token.isEmpty() && approved) {
                m_ready = true;
                m_round = 0;
                setStatus(QStringLiteral("NOVA engine ready"));
                emit stateChanged();
                emit backendReady(baseUrl, token);
                return;
            }
        }
    }

    probeNextPort();
}

QString BackendBootstrap::bundledBackendPath() const {
    const QDir appDir(QCoreApplication::applicationDirPath());
#if defined(Q_OS_WIN)
    return appDir.filePath(QStringLiteral("nova-native-backend.exe"));
#else
    return appDir.filePath(QStringLiteral("nova-native-backend"));
#endif
}

QString BackendBootstrap::pairingSecretForPort(int port) const {
    const QString dataDirectory = nativeDataDirectory();
    if (dataDirectory.isEmpty()) {
        return {};
    }

    QFile file(QDir(dataDirectory).filePath(QStringLiteral("nova-daemon.pairing.json")));
    if (!file.open(QIODevice::ReadOnly)) {
        return {};
    }

    const QJsonDocument document = QJsonDocument::fromJson(file.readAll());
    if (!document.isObject()) {
        return {};
    }

    const QJsonObject object = document.object();
    if (object.value(QStringLiteral("port")).toInt(-1) != port) {
        return {};
    }

    const QString secret = object.value(QStringLiteral("secret")).toString().trimmed();
    return secret.size() >= 24 ? secret : QString();
}

bool BackendBootstrap::launchBundledBackend() {
    const QString backendPath = bundledBackendPath();
    const QFileInfo info(backendPath);
    if (!info.exists() || !info.isFile()) {
        return false;
    }

    QProcessEnvironment environment = QProcessEnvironment::systemEnvironment();
    const QString resourceOverride = qEnvironmentVariable("NOVA_RESOURCE_DIR");
    if (!resourceOverride.trimmed().isEmpty()) {
        environment.insert(QStringLiteral("NOVA_RESOURCE_DIR"), resourceOverride);
    }

    m_backendProcess.setProcessEnvironment(environment);
    m_backendProcess.setProgram(info.absoluteFilePath());
    m_backendProcess.setArguments(QStringList{});
    m_backendProcess.setProcessChannelMode(QProcess::ForwardedErrorChannel);
    m_backendProcess.start();

    if (!m_backendProcess.waitForStarted(1500)) {
        return false;
    }

    m_startedBackend = true;
    return true;
}
