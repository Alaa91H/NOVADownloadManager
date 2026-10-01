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
#include <QStandardPaths>
#include <QSet>
#include <QStringList>

#if defined(Q_OS_WIN)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {
constexpr int kFirstPort = 3199;
constexpr int kLastPort = 3229;
constexpr int kMaxProbeRounds = 40;
constexpr int kRetryDelayMs = 150;
constexpr int kProbeTimeoutMs = 750;
}

BackendBootstrap::BackendBootstrap(QObject *parent)
    : QObject(parent) {
    m_retryTimer.setSingleShot(true);
    connect(&m_retryTimer, &QTimer::timeout, this, &BackendBootstrap::beginProbeRound);
    connect(&m_backendProcess, &QProcess::readyReadStandardError, this, [this]() {
        m_backendOutput.append(m_backendProcess.readAllStandardError());
        constexpr qsizetype kMaxBackendOutputBytes = 64 * 1024;
        if (m_backendOutput.size() > kMaxBackendOutputBytes) {
            m_backendOutput.remove(0, m_backendOutput.size() - kMaxBackendOutputBytes);
        }
    });

    connect(
        &m_backendProcess,
        &QProcess::errorOccurred,
        this,
        [this](QProcess::ProcessError error) {
            if (m_shuttingDown || error == QProcess::Crashed) {
                return;
            }
            reportBootstrapFailure(
                QStringLiteral("NOVA backend could not be started (%1): %2")
                    .arg(static_cast<int>(error))
                    .arg(m_backendProcess.errorString())
            );
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
    m_portsToProbe = candidatePorts();
    m_nextPort = 0;
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
    m_portsToProbe = candidatePorts();
    m_nextPort = 0;
    setStatus(QStringLiteral("Recovering NOVA engine…"));

    if (!m_retryTimer.isActive()) {
        m_retryTimer.start(kRetryDelayMs);
    }
}

void BackendBootstrap::beginProbeRound() {
    if (m_ready) {
        return;
    }

    m_nextPort = 0;
    ++m_round;
    probeNextPort();
}

void BackendBootstrap::probeNextPort() {
    if (m_ready) {
        return;
    }

    if (m_nextPort >= m_portsToProbe.size()) {
        if (!m_startedBackend) {
            if (!launchBundledBackend()) {
                reportBootstrapFailure(
                    QStringLiteral("Bundled NOVA backend is missing or could not be started: %1")
                        .arg(bundledBackendPath())
                );
                return;
            }
            setStatus(QStringLiteral("Starting NOVA engine…"));
        }

        if (m_round >= kMaxProbeRounds) {
            reportBootstrapFailure(QStringLiteral("NOVA engine did not become ready in time."));
            return;
        }

        m_retryTimer.start(kRetryDelayMs);
        return;
    }

    const int port = m_portsToProbe.at(m_nextPort++).toInt();
    const QUrl baseUrl(QStringLiteral("http://127.0.0.1:%1").arg(port));
    QNetworkRequest request(baseUrl.resolved(QUrl(QStringLiteral("/v1/pair/auto"))));
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setRawHeader("Accept", "application/json");
    request.setRawHeader("x-nova-native-desktop", "1");
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

    if (m_nextPort >= m_portsToProbe.size() && m_startedBackend && m_round < kMaxProbeRounds) {
        m_retryTimer.start(kRetryDelayMs);
        return;
    }
    probeNextPort();
}

QString BackendBootstrap::bundledBackendPath() const {
    const QDir appDir(QCoreApplication::applicationDirPath());
#if defined(Q_OS_WIN)
    const QString fileName = QStringLiteral("nova-native-backend.exe");
#else
    const QString fileName = QStringLiteral("nova-native-backend");
#endif
    const QStringList candidates{
        appDir.filePath(fileName),
        appDir.filePath(QStringLiteral("../") + fileName),
        appDir.filePath(QStringLiteral("../bin/") + fileName)
    };
    for (const QString &candidate : candidates) {
        const QFileInfo info(candidate);
        if (info.exists() && info.isFile()) {
            return info.absoluteFilePath();
        }
    }
    return candidates.constFirst();
}

QStringList BackendBootstrap::candidatePorts() const {
    QStringList ports;
    QSet<int> seen;
    const QString appData = qEnvironmentVariable("APPDATA").trimmed();
    if (!appData.isEmpty()) {
        const QString portFile = QDir(appData).filePath(
            QStringLiteral("com.nova.downloadmanager/nova-daemon.port")
        );
        QFile file(portFile);
        if (file.open(QIODevice::ReadOnly | QIODevice::Text)) {
            bool ok = false;
            const int port = QString::fromUtf8(file.readLine()).trimmed().toInt(&ok);
            if (ok && port >= 1024 && port <= 65535) {
                ports.append(QString::number(port));
                seen.insert(port);
            }
        }
    }

    for (int port = kFirstPort; port <= kLastPort; ++port) {
        if (!seen.contains(port)) {
            ports.append(QString::number(port));
        }
    }
    return ports;
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
    m_backendProcess.setWorkingDirectory(info.absolutePath());
    m_backendProcess.setStandardOutputFile(QProcess::nullDevice());
    m_backendOutput.clear();
#if defined(Q_OS_WIN)
    m_backendProcess.setCreateProcessArgumentsModifier(
        [](QProcess::CreateProcessArguments *arguments) {
            arguments->flags |= CREATE_NO_WINDOW;
        }
    );
#endif
    m_backendProcess.start();

    if (!m_backendProcess.waitForStarted(1500)) {
        return false;
    }

    m_startedBackend = true;
    return true;
}

void BackendBootstrap::reportBootstrapFailure(const QString &message) {
    setStatus(message);
    const QString logPath = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation)
        + QStringLiteral("/backend-bootstrap.log");
    const QFileInfo logInfo(logPath);
    QDir().mkpath(logInfo.absolutePath());
    QFile logFile(logPath);
    if (logFile.open(QIODevice::WriteOnly | QIODevice::Append | QIODevice::Text)) {
        logFile.write(message.toUtf8());
        logFile.write("\n");
        logFile.write(m_backendOutput);
        logFile.write("\n");
    }
    emit bootstrapFailed(message);
}
