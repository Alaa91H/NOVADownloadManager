#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QTimer>
#include <QUrl>

#include "api/NovaApiClient.h"
#include "models/DownloadListModel.h"

int main(int argc, char *argv[]) {
    QGuiApplication app(argc, argv);
    QCoreApplication::setOrganizationName(QStringLiteral("NOVA"));
    QCoreApplication::setApplicationName(QStringLiteral("NOVA Download Manager Native"));

    NovaApiClient apiClient;
    DownloadListModel downloadsModel;

    const QByteArray apiBase = qgetenv("NOVA_API_BASE");
    const QByteArray apiToken = qgetenv("NOVA_API_TOKEN");
    if (!apiBase.isEmpty()) {
        apiClient.setBaseUrl(QUrl(QString::fromUtf8(apiBase)));
    }
    if (!apiToken.isEmpty()) {
        apiClient.setBearerToken(QString::fromUtf8(apiToken));
    }

    QObject::connect(&apiClient, &NovaApiClient::downloadsLoaded,
                     &downloadsModel, &DownloadListModel::replaceFromJson);

    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty(QStringLiteral("novaApi"), &apiClient);
    engine.rootContext()->setContextProperty(QStringLiteral("downloadsModel"), &downloadsModel);

    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed,
                     &app, []() { QCoreApplication::exit(-1); },
                     Qt::QueuedConnection);

    engine.loadFromModule(QStringLiteral("Nova.Native"), QStringLiteral("Main"));

    QTimer refreshTimer;
    refreshTimer.setInterval(1500);
    QObject::connect(&refreshTimer, &QTimer::timeout, &apiClient, &NovaApiClient::refreshDownloads);
    refreshTimer.start();

    QTimer healthTimer;
    healthTimer.setInterval(10000);
    QObject::connect(&healthTimer, &QTimer::timeout, &apiClient, &NovaApiClient::checkHealth);
    healthTimer.start();

    apiClient.checkHealth();
    apiClient.refreshDownloads();

    return app.exec();
}
