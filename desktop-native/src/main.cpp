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
#include "platform/BackendBootstrap.h"
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
    BackendBootstrap backendBootstrap;
    ClipboardMonitor clipboardMonitor;
    DesktopIntegration desktopIntegration;
    NativeSettings nativeSettings;
    TrayManager trayManager;
    UpdaterManager updaterManager;

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
    engine.rootContext()->setContextProperty(QStringLiteral("backendBootstrap"), &backendBootstrap);
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

    QTimer healthTimer;
    healthTimer.setInterval(10000);
    QObject::connect(&healthTimer, &QTimer::timeout, &apiClient, &NovaApiClient::checkHealth);

    QTimer browserIntegrationTimer;
    browserIntegrationTimer.setInterval(15000);
    QObject::connect(
        &browserIntegrationTimer,
        &QTimer::timeout,
        &apiClient,
        &NovaApiClient::refreshBrowserIntegration
    );

    QObject::connect(
        &apiClient,
        &NovaApiClient::connectionChanged,
        &app,
        [&apiClient]() {
            if (apiClient.connected()) {
                apiClient.refreshBrowserIntegration();
            }
        }
    );

    bool apiInitialized = false;
    const auto initializeApi = [
        &apiClient,
        &refreshTimer,
        &healthTimer,
        &browserIntegrationTimer,
        &apiInitialized
    ](const QUrl &baseUrl, const QString &token) {
        if (apiInitialized || !baseUrl.isValid() || token.trimmed().isEmpty()) {
            return;
        }

        apiInitialized = true;
        apiClient.setBaseUrl(baseUrl);
        apiClient.setBearerToken(token);

        refreshTimer.start();
        healthTimer.start();
        browserIntegrationTimer.start();

        apiClient.checkHealth();
        apiClient.refreshDownloads();
        apiClient.refreshBrowserIntegration();
        apiClient.startDownloadStream();
    };

    QObject::connect(
        &backendBootstrap,
        &BackendBootstrap::backendReady,
        &app,
        initializeApi
    );
    QObject::connect(
        &backendBootstrap,
        &BackendBootstrap::bootstrapFailed,
        &app,
        [&apiClient](const QString &message) {
            apiClient.reportBootstrapFailure(message);
        }
    );

    const QByteArray apiBase = qgetenv("NOVA_API_BASE");
    const QByteArray apiToken = qgetenv("NOVA_API_TOKEN");
    if (!apiBase.isEmpty() && !apiToken.isEmpty()) {
        initializeApi(
            QUrl(QString::fromUtf8(apiBase)),
            QString::fromUtf8(apiToken)
        );
    } else {
        backendBootstrap.start();
    }

    return app.exec();
}
