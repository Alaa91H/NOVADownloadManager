#include <QApplication>
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QTimer>
#include <QUrl>
#include <QWindow>

#include "api/NovaApiClient.h"
#include "models/DownloadListModel.h"
#include "localization/I18nManager.h"
#include "platform/AppearanceManager.h"
#include "platform/ClipboardMonitor.h"
#include "platform/DesktopIntegration.h"
#include "platform/TrayManager.h"
#include "platform/UpdaterManager.h"
#include "settings/NativeSettings.h"

int main(int argc, char *argv[]) {
    QGuiApplication::setHighDpiScaleFactorRoundingPolicy(
        Qt::HighDpiScaleFactorRoundingPolicy::PassThrough
    );

    QApplication app(argc, argv);
    QCoreApplication::setOrganizationName(QStringLiteral("NOVA"));
    QCoreApplication::setApplicationName(QStringLiteral("NOVA Download Manager Native"));
#ifdef NOVA_NATIVE_VERSION
    QCoreApplication::setApplicationVersion(QStringLiteral(NOVA_NATIVE_VERSION));
#endif

    NovaApiClient apiClient;
    DownloadListModel downloadsModel;
    I18nManager i18nManager;
    AppearanceManager appearanceManager;
    ClipboardMonitor clipboardMonitor;
    DesktopIntegration desktopIntegration;
    NativeSettings nativeSettings;
    TrayManager trayManager;
    UpdaterManager updaterManager;

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
    QObject::connect(&apiClient, &NovaApiClient::downloadsLoaded,
                     &desktopIntegration, &DesktopIntegration::handleDownloads);

    const auto syncClipboardPreferences = [&nativeSettings, &apiClient, &clipboardMonitor]() {
        clipboardMonitor.setEnabled(
            nativeSettings.monitorClipboard() && apiClient.connected()
        );
    };

    const auto syncDesktopPreferences = [&nativeSettings, &trayManager]() {
        trayManager.setNotificationsEnabled(nativeSettings.notificationsEnabled());
        trayManager.setNotifyOnComplete(nativeSettings.notifyOnComplete());
        trayManager.setNotifyOnFailure(nativeSettings.notifyOnFailure());
        trayManager.setEnabled(
            nativeSettings.closeToTray() || nativeSettings.notificationsEnabled()
        );
    };
    syncDesktopPreferences();
    syncClipboardPreferences();
    QObject::connect(&nativeSettings, &NativeSettings::settingsChanged,
                     &app, syncDesktopPreferences);
    QObject::connect(&nativeSettings, &NativeSettings::settingsChanged,
                     &app, syncClipboardPreferences);
    QObject::connect(&apiClient, &NovaApiClient::connectionChanged,
                     &app, syncClipboardPreferences);
    QObject::connect(&trayManager, &TrayManager::quitRequested,
                     &app, [&app]() { app.quit(); });

    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty(QStringLiteral("novaApi"), &apiClient);
    engine.rootContext()->setContextProperty(QStringLiteral("i18n"), &i18nManager);
    engine.rootContext()->setContextProperty(QStringLiteral("appearanceManager"), &appearanceManager);
    engine.rootContext()->setContextProperty(QStringLiteral("clipboardMonitor"), &clipboardMonitor);
    engine.rootContext()->setContextProperty(QStringLiteral("downloadsModel"), &downloadsModel);
    engine.rootContext()->setContextProperty(QStringLiteral("desktopIntegration"), &desktopIntegration);
    engine.rootContext()->setContextProperty(QStringLiteral("nativeSettings"), &nativeSettings);
    engine.rootContext()->setContextProperty(QStringLiteral("trayManager"), &trayManager);
    engine.rootContext()->setContextProperty(QStringLiteral("updaterManager"), &updaterManager);

    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed,
                     &app, []() { QCoreApplication::exit(-1); },
                     Qt::QueuedConnection);

    engine.loadFromModule(QStringLiteral("Nova.Native"), QStringLiteral("Main"));

    if (!engine.rootObjects().isEmpty()) {
        if (auto *window = qobject_cast<QWindow *>(engine.rootObjects().constFirst())) {
            desktopIntegration.setWindow(window);
        }
    }

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
