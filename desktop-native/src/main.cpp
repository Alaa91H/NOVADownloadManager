#include <QApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QTimer>
#include <QUrl>

#include "api/NovaApiClient.h"
#include "models/DownloadListModel.h"
#include "platform/DesktopIntegration.h"
#include "platform/TrayManager.h"
#include "settings/NativeSettings.h"

int main(int argc, char *argv[]) {
    QApplication app(argc, argv);
    QCoreApplication::setOrganizationName(QStringLiteral("NOVA"));
    QCoreApplication::setApplicationName(QStringLiteral("NOVA Download Manager Native"));

    NovaApiClient apiClient;
    DownloadListModel downloadsModel;
    DesktopIntegration desktopIntegration;
    NativeSettings nativeSettings;
    TrayManager trayManager;

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
    QObject::connect(&apiClient, &NovaApiClient::downloadsLoaded,
                     &trayManager, &TrayManager::handleDownloads);

    const auto syncDesktopPreferences = [&nativeSettings, &trayManager]() {
        trayManager.setNotificationsEnabled(nativeSettings.notificationsEnabled());
        trayManager.setNotifyOnComplete(nativeSettings.notifyOnComplete());
        trayManager.setNotifyOnFailure(nativeSettings.notifyOnFailure());
        trayManager.setEnabled(
            nativeSettings.closeToTray() || nativeSettings.notificationsEnabled()
        );
    };
    syncDesktopPreferences();
    QObject::connect(&nativeSettings, &NativeSettings::settingsChanged,
                     &app, syncDesktopPreferences);
    QObject::connect(&trayManager, &TrayManager::quitRequested,
                     &app, [&app]() { app.quit(); });

    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty(QStringLiteral("novaApi"), &apiClient);
    engine.rootContext()->setContextProperty(QStringLiteral("downloadsModel"), &downloadsModel);
    engine.rootContext()->setContextProperty(QStringLiteral("desktopIntegration"), &desktopIntegration);
    engine.rootContext()->setContextProperty(QStringLiteral("nativeSettings"), &nativeSettings);
    engine.rootContext()->setContextProperty(QStringLiteral("trayManager"), &trayManager);

    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed,
                     &app, []() { QCoreApplication::exit(-1); },
                     Qt::QueuedConnection);

    engine.loadFromModule(QStringLiteral("Nova.Native"), QStringLiteral("Main"));

    QTimer refreshTimer;
    refreshTimer.setInterval(60000);
    QObject::connect(&refreshTimer, &QTimer::timeout, &apiClient, &NovaApiClient::refreshDownloads);
    refreshTimer.start();

    QTimer healthTimer;
    healthTimer.setInterval(10000);
    QObject::connect(&healthTimer, &QTimer::timeout, &apiClient, &NovaApiClient::checkHealth);
    healthTimer.start();

    apiClient.checkHealth();
    apiClient.refreshDownloads();
    apiClient.startDownloadStream();

    return app.exec();
}
