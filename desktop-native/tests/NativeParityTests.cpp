#include <QtTest>

#include <algorithm>

#include <QElapsedTimer>
#include <QFile>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSignalSpy>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>

#include "api/NovaApiClient.h"
#include "batch/BatchPatternExpander.h"
#include "models/DownloadListModel.h"
#include "localization/I18nManager.h"
#include "settings/NativeSettings.h"

namespace {

QStringList testSupportedControlPlaneCommands() {
    return {
        QStringLiteral("addDownload"),
        QStringLiteral("addMediaDownload"),
        QStringLiteral("addMediaPlaylist"),
        QStringLiteral("pauseTask"),
        QStringLiteral("resumeTask"),
        QStringLiteral("retryTask"),
        QStringLiteral("redownloadTask"),
        QStringLiteral("deleteTask"),
        QStringLiteral("moveTask"),
        QStringLiteral("setTaskPriority"),
        QStringLiteral("startQueue"),
        QStringLiteral("createQueue"),
        QStringLiteral("updateQueue"),
        QStringLiteral("deleteQueue"),
        QStringLiteral("reorderQueues"),
        QStringLiteral("reorderQueueTasks"),
        QStringLiteral("stopQueue"),
        QStringLiteral("setSchedulerPowerCommands"),
        QStringLiteral("setActiveProfile"),
        QStringLiteral("upsertProfile"),
        QStringLiteral("deleteProfile"),
        QStringLiteral("addRule"),
        QStringLiteral("deleteRule"),
        QStringLiteral("addSchedule"),
        QStringLiteral("updateSchedule"),
        QStringLiteral("deleteSchedule"),
        QStringLiteral("batch.bestEffort"),
    };
}

QByteArray testEngineCapabilities(
    QStringList commandIds = testSupportedControlPlaneCommands(),
    QStringList directOptionKeys = {
        QStringLiteral("referer"), QStringLiteral("userAgent"), QStringLiteral("proxy"),
        QStringLiteral("proxyUser"), QStringLiteral("proxyPassword"), QStringLiteral("headers"),
        QStringLiteral("cookies"), QStringLiteral("retryCount"), QStringLiteral("timeoutSec"),
        QStringLiteral("connectTimeoutSec"), QStringLiteral("retryDelaySec"),
        QStringLiteral("dnsServers"), QStringLiteral("bufferSize"),
        QStringLiteral("keepaliveTimeSec"), QStringLiteral("httpVersion"),
        QStringLiteral("insecure"), QStringLiteral("caCert"), QStringLiteral("cert"),
        QStringLiteral("key"), QStringLiteral("tlsMin"), QStringLiteral("ciphers"),
        QStringLiteral("segmented"), QStringLiteral("range"),
    },
    QStringList mediaOptionKeys = {
        QStringLiteral("mode"), QStringLiteral("quality"), QStringLiteral("formatSelector"),
        QStringLiteral("formatSort"), QStringLiteral("audioFormat"), QStringLiteral("bitrate"),
        QStringLiteral("outputTemplate"), QStringLiteral("playlist"),
        QStringLiteral("playlistItems"), QStringLiteral("subtitles"),
        QStringLiteral("subtitleLanguages"), QStringLiteral("autoSubtitles"),
        QStringLiteral("embedSubtitles"), QStringLiteral("writeThumbnail"),
        QStringLiteral("embedThumbnail"), QStringLiteral("writeInfoJson"),
        QStringLiteral("writeDescription"), QStringLiteral("splitChapters"),
        QStringLiteral("sponsorBlock"), QStringLiteral("proxy"),
        QStringLiteral("sourceAddress"), QStringLiteral("cookiesFromBrowser"),
        QStringLiteral("userAgent"), QStringLiteral("referer"), QStringLiteral("headers"),
        QStringLiteral("cookies"), QStringLiteral("rateLimitKbs"), QStringLiteral("retries"),
        QStringLiteral("fragmentRetries"), QStringLiteral("concurrentFragments"),
        QStringLiteral("sleepIntervalSec"), QStringLiteral("maxSleepIntervalSec"),
        QStringLiteral("downloadSections"), QStringLiteral("matchFilter"),
        QStringLiteral("remuxFormat"),
    },
    QStringList directProtocols = {
        QStringLiteral("http"), QStringLiteral("https"), QStringLiteral("ftp"),
    }
) {
    QJsonArray commands;
    for (const QString &id : commandIds) {
        commands.append(QJsonObject{
            {QStringLiteral("id"), id},
            {QStringLiteral("status"), QStringLiteral("supported")},
        });
    }

    const auto jsonStrings = [](const QStringList &values) {
        QJsonArray result;
        for (const QString &value : values) result.append(value);
        return result;
    };

    const QJsonObject body{
        {QStringLiteral("directReady"), true},
        {QStringLiteral("mediaExtractionReady"), true},
        {QStringLiteral("postProcessingReady"), true},
        {QStringLiteral("directProtocols"), jsonStrings(directProtocols)},
        {QStringLiteral("engines"), QJsonObject{
            {QStringLiteral("curl"), QJsonObject{
                {QStringLiteral("supportedDirectOptionKeys"), jsonStrings(directOptionKeys)},
            }},
            {QStringLiteral("media"), QJsonObject{
                {QStringLiteral("supportedMediaOptionKeys"), jsonStrings(mediaOptionKeys)},
            }},
        }},
        {QStringLiteral("controlPlane"), QJsonObject{
            {QStringLiteral("commandCapabilities"), commands},
        }},
    };
    return QJsonDocument(body).toJson(QJsonDocument::Compact);
}

QByteArray testControlResponse(const QJsonObject &result) {
    return QJsonDocument(QJsonObject{
        {QStringLiteral("contractVersion"), 1},
        {QStringLiteral("requestId"), QStringLiteral("native-test")},
        {QStringLiteral("result"), result},
    }).toJson(QJsonDocument::Compact);
}

QJsonObject controlCommandFromBody(const QByteArray &body) {
    return QJsonDocument::fromJson(body).object()
        .value(QStringLiteral("command")).toObject();
}

QJsonObject controlQueryFromBody(const QByteArray &body) {
    return QJsonDocument::fromJson(body).object()
        .value(QStringLiteral("query")).toObject();
}

} // namespace

class NativeParityTests final : public QObject {
    Q_OBJECT

private slots:
    void largeListRemainsResponsive();
    void streamReconnectsAfterDaemonReturns();
    void reconnectBackoffIsBounded();
    void legacyUiPreferencesMigrateOnce();
    void releaseLocalizationIsEnglishArabicOnly();
    void shellCustomizationPersists();
    void batchPatternsMatchLegacySyntax();
    void batchImportCarriesAdvancedOptions();
    void batchImportHonorsRuntimeCapabilities();
    void mediaDownloadCarriesAdvancedOptions();
    void mediaDownloadHonorsRuntimeCapabilities();
    void queueCatalogManagementIsDaemonBacked();
    void queueStartStopIsDaemonBacked();
    void schedulerStatusCarriesCompletionControls();
    void advancedSettingsMigrateAndBackupSafely();
    void advancedDownloadCarriesNetworkDefaults();
    void settingsServicesReachDaemon();
    void bulkShortcutActionsRespectTaskLifecycle();
};

void NativeParityTests::largeListRemainsResponsive() {
    constexpr int itemCount = 20000;
    QJsonArray downloads;

    for (int i = 0; i < itemCount; ++i) {
        QJsonObject item;
        item.insert(QStringLiteral("id"), QStringLiteral("task-%1").arg(i, 6, 10, QLatin1Char('0')));
        item.insert(QStringLiteral("name"), QStringLiteral("download-%1.bin").arg(i));
        item.insert(QStringLiteral("url"), QStringLiteral("https://example.test/files/%1").arg(i));
        item.insert(
            QStringLiteral("status"),
            i % 4 == 0 ? QStringLiteral("downloading") : QStringLiteral("completed")
        );
        item.insert(QStringLiteral("sizeBytes"), 10'000'000 + i);
        item.insert(QStringLiteral("downloadedBytes"), i % 4 == 0 ? 5'000'000 : 10'000'000 + i);
        item.insert(QStringLiteral("speedBytesPerSec"), i % 4 == 0 ? 2'000'000 + i : 0);
        item.insert(QStringLiteral("timeLeftSeconds"), i % 4 == 0 ? 5 : 0);
        item.insert(QStringLiteral("elapsedSeconds"), i);
        item.insert(QStringLiteral("savePath"), QStringLiteral("/tmp/NOVA/download-%1.bin").arg(i));
        item.insert(QStringLiteral("engine"), QStringLiteral("native"));
        item.insert(QStringLiteral("fileType"), i % 2 == 0 ? QStringLiteral("video") : QStringLiteral("document"));
        item.insert(QStringLiteral("category"), i % 2 == 0 ? QStringLiteral("video") : QStringLiteral("document"));
        item.insert(
            QStringLiteral("queueId"),
            i % 3 == 0 ? QStringLiteral("fast")
                : i % 3 == 1 ? QStringLiteral("main") : QStringLiteral("night")
        );
        item.insert(QStringLiteral("connections"), i % 5 == 0 ? 0 : 8);
        item.insert(QStringLiteral("retries"), i % 4);
        item.insert(
            QStringLiteral("completedAt"),
            i % 4 == 0 ? QString() : QStringLiteral("2026-09-24T13:00:00Z")
        );
        item.insert(QStringLiteral("crc32"), QStringLiteral("%1").arg(i, 8, 16, QLatin1Char('0')));
        if (i == 0)
            item.insert(QStringLiteral("engineStatus"), QStringLiteral("live-recording-paused"));
        item.insert(QStringLiteral("resumable"), true);
        item.insert(
            QStringLiteral("dateAdded"),
            QStringLiteral("2026-09-24T12:%1:%2Z")
                .arg((i / 60) % 60, 2, 10, QLatin1Char('0'))
                .arg(i % 60, 2, 10, QLatin1Char('0'))
        );
        downloads.append(item);
    }

    DownloadListModel model;
    QElapsedTimer timer;
    timer.start();
    model.replaceFromJson(downloads);
    const qint64 initialLoadMs = timer.elapsed();
    qInfo().noquote() << "large-list initial-load-ms=" << initialLoadMs;

    QCOMPARE(model.totalCount(), itemCount);
    QCOMPARE(model.count(), itemCount);
    QCOMPARE(model.activeCount(), itemCount / 4);
    QCOMPARE(model.queuedCount(), 0);
    QCOMPARE(model.completedCount(), itemCount - itemCount / 4);
    QCOMPARE(model.failedCount(), 0);
    QCOMPARE(
        model.itemById(QStringLiteral("task-000000"))
            .value(QStringLiteral("engineStatus")).toString(),
        QStringLiteral("live-recording-paused")
    );
    QVERIFY2(
        initialLoadMs < 8000,
        qPrintable(QStringLiteral("20k model load took %1 ms").arg(initialLoadMs))
    );

    timer.restart();
    model.setFilterState(QStringLiteral("active"));
    const qint64 filterMs = timer.elapsed();
    qInfo().noquote() << "large-list active-filter-ms=" << filterMs;
    QCOMPARE(model.count(), itemCount / 4);
    QVERIFY2(
        filterMs < 3000,
        "Filtering 20k downloads exceeded the native UI stress budget"
    );

    timer.restart();
    model.setSortKey(QStringLiteral("speed"));
    model.setSortAscending(false);
    const qint64 speedSortMs = timer.elapsed();
    qInfo().noquote() << "large-list speed-sort-ms=" << speedSortMs;
    QVERIFY2(
        speedSortMs < 3000,
        "Sorting the active large-list view exceeded the native UI stress budget"
    );

    timer.restart();
    model.setFilterState(QStringLiteral("downloads"));
    model.setSearchQuery(QStringLiteral("download-19999.bin"));
    const qint64 searchMs = timer.elapsed();
    qInfo().noquote() << "large-list restore-and-search-ms=" << searchMs;
    QCOMPARE(model.count(), 1);
    QCOMPARE(model.itemAt(0).value(QStringLiteral("taskId")).toString(), QStringLiteral("task-019999"));
    const QVariantMap extended = model.itemAt(0);
    QCOMPARE(extended.value(QStringLiteral("elapsedSeconds")).toInt(), 19999);
    QCOMPARE(extended.value(QStringLiteral("fileType")).toString(), QStringLiteral("document"));
    QCOMPARE(extended.value(QStringLiteral("queueId")).toString(), QStringLiteral("main"));
    QCOMPARE(extended.value(QStringLiteral("connections")).toInt(), 8);
    QCOMPARE(extended.value(QStringLiteral("retries")).toInt(), 3);
    QVERIFY(!extended.value(QStringLiteral("completedAt")).toString().isEmpty());
    QVERIFY(!extended.value(QStringLiteral("crc32")).toString().isEmpty());
    QVERIFY2(
        searchMs < 3000,
        "Searching 20k downloads exceeded the native UI stress budget"
    );

    model.setSearchQuery(QString());
    model.setSortKey(QStringLiteral("priority"));
    model.setSortAscending(false);
    QCOMPARE(
        model.itemAt(0).value(QStringLiteral("queueId")).toString(),
        QStringLiteral("fast")
    );

    model.setSortKey(QStringLiteral("elapsed"));
    model.setSortAscending(false);
    QCOMPARE(
        model.itemAt(0).value(QStringLiteral("elapsedSeconds")).toInt(),
        itemCount - 1
    );

    model.setSortKey(QStringLiteral("sourceUrl"));
    model.setSortAscending(true);
    QVERIFY(
        model.itemAt(0).value(QStringLiteral("url")).toString()
            .startsWith(QStringLiteral("https://example.test/files/"))
    );
}

void NativeParityTests::streamReconnectsAfterDaemonReturns() {
    QTcpServer reservation;
    QVERIFY(reservation.listen(QHostAddress::LocalHost, 0));
    const quint16 port = reservation.serverPort();
    reservation.close();

    NovaApiClient client;
    client.setBaseUrl(QUrl(QStringLiteral("http://127.0.0.1:%1").arg(port)));

    QSignalSpy reconnectSpy(&client, &NovaApiClient::streamReconnectScheduled);
    QSignalSpy liveSpy(&client, &NovaApiClient::liveUpdatesChanged);

    client.startDownloadStream();
    QTRY_VERIFY_WITH_TIMEOUT(reconnectSpy.count() >= 1, 2500);
    QVERIFY(!client.liveUpdatesConnected());

    QTcpServer server;
    connect(&server, &QTcpServer::newConnection, &server, [&server]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            socket->write(
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: text/event-stream\r\n"
                "Cache-Control: no-cache\r\n"
                "Connection: keep-alive\r\n"
                "\r\n"
                "event: downloads\n"
                "data: []\n\n"
            );
            socket->flush();
        }
    });
    QVERIFY(server.listen(QHostAddress::LocalHost, port));

    QTRY_VERIFY_WITH_TIMEOUT(client.liveUpdatesConnected(), 6000);
    QVERIFY(liveSpy.count() >= 1);

    const QList<QVariant> firstReconnect = reconnectSpy.at(0);
    QVERIFY(!firstReconnect.isEmpty());
    QCOMPARE(firstReconnect.at(0).toInt(), 250);
}

void NativeParityTests::reconnectBackoffIsBounded() {
    QCOMPARE(NovaApiClient::streamReconnectDelayForAttempt(0), 250);
    QCOMPARE(NovaApiClient::streamReconnectDelayForAttempt(1), 500);
    QCOMPARE(NovaApiClient::streamReconnectDelayForAttempt(2), 1000);
    QCOMPARE(NovaApiClient::streamReconnectDelayForAttempt(3), 2000);
    QCOMPARE(NovaApiClient::streamReconnectDelayForAttempt(4), 4000);
    QCOMPARE(NovaApiClient::streamReconnectDelayForAttempt(5), 5000);
    QCOMPARE(NovaApiClient::streamReconnectDelayForAttempt(50), 5000);
    QCOMPARE(NovaApiClient::streamReconnectDelayForAttempt(-10), 250);
}


void NativeParityTests::legacyUiPreferencesMigrateOnce() {
    QTemporaryDir temp;
    QVERIFY(temp.isValid());

    const QByteArray previousDataDir = qgetenv("NOVA_NATIVE_DATA_DIR");
    qputenv("NOVA_NATIVE_DATA_DIR", temp.path().toUtf8());

    const QString configPath = temp.filePath(QStringLiteral("config.json"));
    QFile config(configPath);
    QVERIFY(config.open(QIODevice::WriteOnly | QIODevice::Truncate));
    const QJsonObject legacy{
        {
            QStringLiteral("general"),
            QJsonObject{{QStringLiteral("monitorClipboard"), true}}
        },
        {
            QStringLiteral("connection"),
            QJsonObject{{QStringLiteral("maxConnections"), 24}}
        },
        {
            QStringLiteral("saveAndCategories"),
            QJsonObject{{QStringLiteral("defaultFolder"), QStringLiteral("/legacy/downloads")}}
        },
        {
            QStringLiteral("extra"),
            QJsonObject{{QStringLiteral("language"), QStringLiteral("de-DE")}}
        }
    };
    config.write(QJsonDocument(legacy).toJson(QJsonDocument::Compact));
    config.close();

    const QString settingsFile = temp.filePath(QStringLiteral("native-settings.ini"));
    {
        NativeSettings settings(settingsFile, nullptr);
        QCOMPARE(settings.defaultSaveDirectory(), QStringLiteral("/legacy/downloads"));
        QCOMPARE(settings.defaultConnections(), 24);
        QVERIFY(settings.monitorClipboard());
        QCOMPARE(settings.uiLanguage(), QStringLiteral("en"));

        settings.setDefaultConnections(8);
        settings.setMonitorClipboard(false);
    }

    QVERIFY(config.open(QIODevice::WriteOnly | QIODevice::Truncate));
    const QJsonObject changedLegacy{
        {
            QStringLiteral("general"),
            QJsonObject{{QStringLiteral("monitorClipboard"), true}}
        },
        {
            QStringLiteral("connection"),
            QJsonObject{{QStringLiteral("maxConnections"), 32}}
        },
        {
            QStringLiteral("saveAndCategories"),
            QJsonObject{{QStringLiteral("defaultFolder"), QStringLiteral("/changed/legacy")}}
        },
        {
            QStringLiteral("extra"),
            QJsonObject{{QStringLiteral("language"), QStringLiteral("ar")}}
        }
    };
    config.write(QJsonDocument(changedLegacy).toJson(QJsonDocument::Compact));
    config.close();

    {
        NativeSettings settings(settingsFile, nullptr);
        QCOMPARE(settings.defaultSaveDirectory(), QStringLiteral("/legacy/downloads"));
        QCOMPARE(settings.defaultConnections(), 8);
        QVERIFY(!settings.monitorClipboard());
        QCOMPARE(settings.uiLanguage(), QStringLiteral("en"));
        settings.resetToDefaults();
    }

    {
        NativeSettings settings(settingsFile, nullptr);
        QCOMPARE(settings.defaultConnections(), 8);
        QVERIFY(!settings.monitorClipboard());
        QCOMPARE(settings.uiLanguage(), QStringLiteral("en"));
        QVERIFY(settings.defaultSaveDirectory() != QStringLiteral("/changed/legacy"));
    }

    if (previousDataDir.isEmpty()) {
        qunsetenv("NOVA_NATIVE_DATA_DIR");
    } else {
        qputenv("NOVA_NATIVE_DATA_DIR", previousDataDir);
    }
}


void NativeParityTests::releaseLocalizationIsEnglishArabicOnly() {
    I18nManager i18n;
    const QVariantList languages = i18n.supportedLanguages();

    QCOMPARE(languages.size(), 2);
    QCOMPARE(
        languages.at(0).toMap().value(QStringLiteral("code")).toString(),
        QStringLiteral("en")
    );
    QCOMPARE(
        languages.at(1).toMap().value(QStringLiteral("code")).toString(),
        QStringLiteral("ar")
    );

    i18n.setLanguage(QStringLiteral("en-US"));
    QCOMPARE(i18n.language(), QStringLiteral("en"));
    QCOMPARE(i18n.translate(QStringLiteral("action.delete")), QStringLiteral("Delete"));
    QVERIFY(!i18n.rtl());

    i18n.setLanguage(QStringLiteral("ar-SA"));
    QCOMPARE(i18n.language(), QStringLiteral("ar"));
    QCOMPARE(i18n.translate(QStringLiteral("action.delete")), QStringLiteral("حذف"));
    QVERIFY(i18n.rtl());

    i18n.setLanguage(QStringLiteral("de-DE"));
    QCOMPARE(i18n.language(), QStringLiteral("en"));
    QVERIFY(!i18n.rtl());

    i18n.setLanguage(QStringLiteral("fr-FR"));
    QCOMPARE(i18n.language(), QStringLiteral("en"));
    QCOMPARE(i18n.translate(QStringLiteral("settings.language")), QStringLiteral("Language"));
}

void NativeParityTests::shellCustomizationPersists() {
    QTemporaryDir temp;
    QVERIFY(temp.isValid());

    const QByteArray previousDataDir = qgetenv("NOVA_NATIVE_DATA_DIR");
    qputenv("NOVA_NATIVE_DATA_DIR", temp.path().toUtf8());

    const QString settingsFile = temp.filePath(QStringLiteral("native-layout.ini"));
    {
        NativeSettings settings(settingsFile, nullptr);
        QVERIFY(settings.sidebarVisible());
        QVERIFY(settings.sidebarCollapsed());
        QVERIFY(settings.detailsPanelVisible());
        QVERIFY(settings.statusBarVisible());
        QCOMPARE(settings.interfaceDensity(), QStringLiteral("comfortable"));
        QCOMPARE(settings.accentColor(), QStringLiteral("#168df7"));
        QCOMPARE(settings.cornerRadius(), 10);

        settings.setSidebarVisible(false);
        settings.setSidebarCollapsed(false);
        settings.setDetailsPanelVisible(false);
        settings.setStatusBarVisible(false);
        settings.setInterfaceDensity(QStringLiteral("dense"));
        settings.setAccentColor(QStringLiteral("#7c5cff"));
        settings.setCornerRadius(14);
    }

    {
        NativeSettings settings(settingsFile, nullptr);
        QVERIFY(!settings.sidebarVisible());
        QVERIFY(!settings.sidebarCollapsed());
        QVERIFY(!settings.detailsPanelVisible());
        QVERIFY(!settings.statusBarVisible());
        QCOMPARE(settings.interfaceDensity(), QStringLiteral("dense"));
        QCOMPARE(settings.accentColor(), QStringLiteral("#7c5cff"));
        QCOMPARE(settings.cornerRadius(), 14);
    }

    if (previousDataDir.isEmpty()) {
        qunsetenv("NOVA_NATIVE_DATA_DIR");
    } else {
        qputenv("NOVA_NATIVE_DATA_DIR", previousDataDir);
    }
}


void NativeParityTests::batchPatternsMatchLegacySyntax() {
    {
        const auto expanded = Nova::BatchPattern::expandInput(
            QStringLiteral("https://example.test/file[01-05:2]_[a-c].zip")
        );
        QVERIFY(expanded.ok());
        QCOMPARE(expanded.urls.size(), 9);
        QCOMPARE(expanded.urls.first(), QStringLiteral("https://example.test/file01_a.zip"));
        QCOMPARE(expanded.urls.at(1), QStringLiteral("https://example.test/file01_b.zip"));
        QCOMPARE(expanded.urls.at(3), QStringLiteral("https://example.test/file03_a.zip"));
        QCOMPARE(expanded.urls.last(), QStringLiteral("https://example.test/file05_c.zip"));

        const auto preview = Nova::BatchPattern::countInput(
            QStringLiteral("https://example.test/file[01-05:2]_[a-c].zip")
        );
        QVERIFY(preview.ok());
        QCOMPARE(preview.count, 9);
    }

    {
        const auto expanded = Nova::BatchPattern::expandInput(
            QStringLiteral(
                "https://example.test/a[1-2].bin\n"
                "https://example.test/b[x-z:2].bin"
            )
        );
        QVERIFY(expanded.ok());
        QCOMPARE(
            expanded.urls,
            QStringList({
                QStringLiteral("https://example.test/a1.bin"),
                QStringLiteral("https://example.test/a2.bin"),
                QStringLiteral("https://example.test/bx.bin"),
                QStringLiteral("https://example.test/bz.bin")
            })
        );
    }

    {
        const auto expanded = Nova::BatchPattern::expandInput(
            QStringLiteral("https://example.test/file[1-10000].bin")
        );
        QVERIFY(expanded.ok());
        QCOMPARE(expanded.urls.size(), Nova::BatchPattern::MaxExpandedUrls);
    }

    {
        const auto expanded = Nova::BatchPattern::expandInput(
            QStringLiteral("https://example.test/file[1-10001].bin")
        );
        QVERIFY(!expanded.ok());
        QVERIFY(expanded.urls.isEmpty());
        QVERIFY(expanded.error.contains(QString::number(Nova::BatchPattern::MaxExpandedUrls)));

        const auto preview = Nova::BatchPattern::countInput(
            QStringLiteral("https://example.test/file[1-10001].bin")
        );
        QVERIFY(!preview.ok());
        QCOMPARE(preview.count, 0);
        QVERIFY(preview.error.contains(QString::number(Nova::BatchPattern::MaxExpandedUrls)));
    }
}

void NativeParityTests::batchImportCarriesAdvancedOptions() {
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));

    QByteArray capturedBody;
    connect(&server, &QTcpServer::newConnection, &server, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            auto *buffer = new QByteArray();
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            QObject::connect(socket, &QTcpSocket::disconnected, socket, [buffer]() {
                delete buffer;
            });
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket, buffer, &capturedBody]() {
                buffer->append(socket->readAll());
                const int headerEnd = buffer->indexOf("\r\n\r\n");
                if (headerEnd < 0) {
                    return;
                }

                const QByteArray headers = buffer->left(headerEnd);
                const QByteArray requestLine = headers.left(headers.indexOf("\r\n"));
                if (requestLine.startsWith("GET /api/engines/capabilities ")) {
                    const QByteArray responseBody = testEngineCapabilities();
                    socket->write(
                        "HTTP/1.1 200 OK\r\n"
                        "Content-Type: application/json\r\n"
                        "Connection: close\r\n"
                        "Content-Length: " + QByteArray::number(responseBody.size()) + "\r\n"
                        "\r\n" + responseBody
                    );
                    socket->flush();
                    socket->disconnectFromHost();
                    return;
                }

                const QRegularExpression lengthPattern(
                    QStringLiteral("Content-Length:\\s*(\\d+)"),
                    QRegularExpression::CaseInsensitiveOption
                );
                const QRegularExpressionMatch match =
                    lengthPattern.match(QString::fromLatin1(headers));
                if (!match.hasMatch()) {
                    return;
                }

                const int contentLength = match.captured(1).toInt();
                const int bodyStart = headerEnd + 4;
                if (buffer->size() < bodyStart + contentLength) {
                    return;
                }

                const QByteArray requestBody = buffer->mid(bodyStart, contentLength);
                QByteArray responseBody;
                if (requestLine.startsWith("POST /api/v1/queries ")) {
                    const QJsonArray queues{
                        QJsonObject{{QStringLiteral("id"), QStringLiteral("main")},
                                    {QStringLiteral("name"), QStringLiteral("Main Queue")}},
                        QJsonObject{{QStringLiteral("id"), QStringLiteral("night")},
                                    {QStringLiteral("name"), QStringLiteral("Night Queue")},
                                    {QStringLiteral("downloadOrder"), QJsonArray{}}},
                    };
                    responseBody = testControlResponse(QJsonObject{
                        {QStringLiteral("queues"), queues},
                    });
                } else {
                    capturedBody = requestBody;
                    const QJsonObject command = controlCommandFromBody(requestBody);
                    const int commandCount = command.value(QStringLiteral("commands")).toArray().size();
                    responseBody = testControlResponse(QJsonObject{
                        {QStringLiteral("succeeded"), commandCount},
                        {QStringLiteral("failed"), 0},
                    });
                }
                socket->write(
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: application/json\r\n"
                    "Connection: close\r\n"
                    "Content-Length: " + QByteArray::number(responseBody.size()) + "\r\n"
                    "\r\n" + responseBody
                );
                socket->flush();
                socket->disconnectFromHost();
            });
        }
    });

    NovaApiClient client;
    client.setBaseUrl(
        QUrl(QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort()))
    );

    QSignalSpy capabilitySpy(&client, &NovaApiClient::engineManagementChanged);
    client.refreshEngineCapabilities();
    QTRY_VERIFY_WITH_TIMEOUT(capabilitySpy.count() >= 1, 3000);
    client.refreshQueueCatalog();
    QTRY_VERIFY_WITH_TIMEOUT(client.knownQueueIds().contains(QStringLiteral("night")), 3000);
    QCOMPARE(client.queueCatalog().size(), 2);
    QCOMPARE(
        client.queueCatalog().at(1).toMap().value(QStringLiteral("name")).toString(),
        QStringLiteral("Night Queue")
    );

    const QVariantMap advanced{
        {QStringLiteral("referer"), QStringLiteral("https://origin.test/page")},
        {QStringLiteral("userAgent"), QStringLiteral("NOVA-Test-Agent")},
        {QStringLiteral("proxy"), QStringLiteral("https://8.8.8.8:8080")},
        {QStringLiteral("headers"), QStringLiteral("X-Test: one\nX-Trace: two")},
        {QStringLiteral("cookies"), QStringLiteral("sid=abc")},
        {QStringLiteral("retryCount"), 7},
        {QStringLiteral("timeoutSec"), 45}
    };
    const QVariantMap options{
        {QStringLiteral("queueId"), QStringLiteral("night")},
        {QStringLiteral("advanced"), advanced}
    };

    QSignalSpy batchStartedSpy(&client, &NovaApiClient::batchImportStarted);

    client.importBatch(
        QStringLiteral(
            "https://example.test/file.zip\n"
            "https://example.test/file.zip"
        ),
        QString(),
        8,
        false,
        options
    );

    QTRY_VERIFY_WITH_TIMEOUT(!capturedBody.isEmpty(), 3000);
    QTRY_VERIFY_WITH_TIMEOUT(batchStartedSpy.count() >= 1, 3000);
    QCOMPARE(batchStartedSpy.at(0).at(0).toInt(), 1);
    QCOMPARE(batchStartedSpy.at(0).at(1).toInt(), 1);

    const QJsonObject command = controlCommandFromBody(capturedBody);
    QCOMPARE(command.value(QStringLiteral("type")).toString(), QStringLiteral("batch"));
    const QJsonArray commands = command.value(QStringLiteral("commands")).toArray();
    QCOMPARE(commands.size(), 1);
    const QJsonObject body = commands.at(0).toObject()
        .value(QStringLiteral("request")).toObject();
    QCOMPARE(body.value(QStringLiteral("queueId")).toString(), QStringLiteral("night"));
    QCOMPARE(body.value(QStringLiteral("connections")).toInt(), 8);
    QVERIFY(!body.value(QStringLiteral("startImmediately")).toBool());

    const QJsonObject direct = body.value(QStringLiteral("directOptions")).toObject();
    QCOMPARE(
        direct.value(QStringLiteral("referer")).toString(),
        QStringLiteral("https://origin.test/page")
    );
    QCOMPARE(
        direct.value(QStringLiteral("userAgent")).toString(),
        QStringLiteral("NOVA-Test-Agent")
    );
    QCOMPARE(
        direct.value(QStringLiteral("proxy")).toString(),
        QStringLiteral("https://8.8.8.8:8080")
    );
    QCOMPARE(
        direct.value(QStringLiteral("headers")).toString(),
        QStringLiteral("X-Test: one\nX-Trace: two")
    );
    QCOMPARE(
        direct.value(QStringLiteral("cookies")).toString(),
        QStringLiteral("sid=abc")
    );
    QCOMPARE(direct.value(QStringLiteral("retryCount")).toInt(), 7);
    QCOMPARE(direct.value(QStringLiteral("timeoutSec")).toInt(), 45);
    QVERIFY(direct.value(QStringLiteral("segmented")).toBool());
}

void NativeParityTests::batchImportHonorsRuntimeCapabilities() {
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));

    QByteArray capturedBody;
    connect(&server, &QTcpServer::newConnection, &server, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            auto *buffer = new QByteArray();
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            QObject::connect(socket, &QTcpSocket::disconnected, socket, [buffer]() {
                delete buffer;
            });
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket, buffer, &capturedBody]() {
                buffer->append(socket->readAll());
                const int headerEnd = buffer->indexOf("\r\n\r\n");
                if (headerEnd < 0) {
                    return;
                }

                const QByteArray headers = buffer->left(headerEnd);
                const QByteArray requestLine = headers.left(headers.indexOf("\r\n"));
                if (requestLine.startsWith("GET /api/engines/capabilities ")) {
                    const QByteArray responseBody = testEngineCapabilities(
                        {QStringLiteral("addDownload")},
                        {QStringLiteral("referer"), QStringLiteral("retryCount")},
                        {},
                        {QStringLiteral("https")}
                    );
                    socket->write(
                        "HTTP/1.1 200 OK\r\n"
                        "Content-Type: application/json\r\n"
                        "Connection: close\r\n"
                        "Content-Length: " + QByteArray::number(responseBody.size()) + "\r\n"
                        "\r\n" + responseBody
                    );
                    socket->flush();
                    socket->disconnectFromHost();
                    return;
                }

                const QRegularExpression lengthPattern(
                    QStringLiteral("Content-Length:\\s*(\\d+)"),
                    QRegularExpression::CaseInsensitiveOption
                );
                const QRegularExpressionMatch match =
                    lengthPattern.match(QString::fromLatin1(headers));
                if (!match.hasMatch()) {
                    return;
                }

                const int contentLength = match.captured(1).toInt();
                const int bodyStart = headerEnd + 4;
                if (buffer->size() < bodyStart + contentLength) {
                    return;
                }

                capturedBody = buffer->mid(bodyStart, contentLength);
                const QJsonObject command = controlCommandFromBody(capturedBody);
                const int commandCount = command.value(QStringLiteral("commands")).toArray().size();
                const QByteArray responseBody = testControlResponse(QJsonObject{
                    {QStringLiteral("succeeded"), commandCount},
                    {QStringLiteral("failed"), 0},
                });
                socket->write(
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: application/json\r\n"
                    "Connection: close\r\n"
                    "Content-Length: " + QByteArray::number(responseBody.size()) + "\r\n"
                    "\r\n" + responseBody
                );
                socket->flush();
                socket->disconnectFromHost();
            });
        }
    });

    NovaApiClient client;
    client.setBaseUrl(
        QUrl(QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort()))
    );

    QSignalSpy capabilitySpy(&client, &NovaApiClient::engineManagementChanged);
    client.refreshEngineCapabilities();
    QTRY_VERIFY_WITH_TIMEOUT(capabilitySpy.count() >= 1, 3000);
    QVERIFY(client.directOptionSupported(QStringLiteral("referer")));
    QVERIFY(client.directOptionSupported(QStringLiteral("retryCount")));
    QVERIFY(!client.directOptionSupported(QStringLiteral("proxy")));
    QVERIFY(!client.directOptionSupported(QStringLiteral("headers")));
    QVERIFY(!client.directOptionSupported(QStringLiteral("segmented")));

    const QVariantMap advanced{
        {QStringLiteral("referer"), QStringLiteral("https://origin.test/page")},
        {QStringLiteral("proxy"), QStringLiteral("https://8.8.8.8:8080")},
        {QStringLiteral("headers"), QStringLiteral("X-Test: blocked")},
        {QStringLiteral("retryCount"), 4}
    };

    QSignalSpy batchStartedSpy(&client, &NovaApiClient::batchImportStarted);

    client.importBatch(
        QStringLiteral(
            "ftp://example.test/blocked.bin\n"
            "https://example.test/file[01-03:2]_[a-b].zip"
        ),
        QString(),
        8,
        false,
        QVariantMap{
            {QStringLiteral("queueId"), QStringLiteral("main")},
            {QStringLiteral("advanced"), advanced}
        }
    );

    QTRY_VERIFY_WITH_TIMEOUT(!capturedBody.isEmpty(), 3000);
    QTRY_VERIFY_WITH_TIMEOUT(batchStartedSpy.count() >= 1, 3000);
    QCOMPARE(batchStartedSpy.at(0).at(0).toInt(), 4);
    QCOMPARE(batchStartedSpy.at(0).at(1).toInt(), 0);

    const QJsonObject command = controlCommandFromBody(capturedBody);
    QCOMPARE(command.value(QStringLiteral("type")).toString(), QStringLiteral("batch"));
    const QJsonArray commands = command.value(QStringLiteral("commands")).toArray();
    QCOMPARE(commands.size(), 4);
    const QJsonObject body = commands.at(0).toObject()
        .value(QStringLiteral("request")).toObject();
    QCOMPARE(body.value(QStringLiteral("connections")).toInt(), 1);
    const QJsonObject direct = body.value(QStringLiteral("directOptions")).toObject();
    QCOMPARE(
        direct.value(QStringLiteral("referer")).toString(),
        QStringLiteral("https://origin.test/page")
    );
    QCOMPARE(direct.value(QStringLiteral("retryCount")).toInt(), 4);
    QVERIFY(!direct.contains(QStringLiteral("proxy")));
    QVERIFY(!direct.contains(QStringLiteral("headers")));
    QVERIFY(!direct.contains(QStringLiteral("segmented")));
}



void NativeParityTests::mediaDownloadCarriesAdvancedOptions() {
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));

    QByteArray capturedBody;
    QByteArray capturedRequestLine;
    connect(&server, &QTcpServer::newConnection, &server, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            auto *buffer = new QByteArray();
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            QObject::connect(socket, &QTcpSocket::disconnected, socket, [buffer]() { delete buffer; });
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket, buffer, &capturedBody, &capturedRequestLine]() {
                buffer->append(socket->readAll());
                const int headerEnd = buffer->indexOf("\r\n\r\n");
                if (headerEnd < 0) return;

                const QByteArray headers = buffer->left(headerEnd);
                const QByteArray requestLine = headers.left(headers.indexOf("\r\n"));
                if (requestLine.startsWith("POST "))
                    capturedRequestLine = requestLine;

                if (requestLine.startsWith("GET /api/engines/capabilities ")) {
                    const QByteArray responseBody = testEngineCapabilities();
                    socket->write(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                        + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                    );
                    socket->disconnectFromHost();
                    return;
                }
                if (requestLine.startsWith("GET /api/downloads ")) {
                    const QByteArray body = "[]";
                    socket->write(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                        + QByteArray::number(body.size()) + "\r\n\r\n" + body
                    );
                    socket->disconnectFromHost();
                    return;
                }
                if (requestLine.startsWith("GET /api/engine/queue ")) {
                    const QByteArray body =
                        "{\"ok\":true,\"entries\":[],\"active_count\":0,\"total_bandwidth_kbps\":0,\"next_to_start\":null}";
                    socket->write(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                        + QByteArray::number(body.size()) + "\r\n\r\n" + body
                    );
                    socket->disconnectFromHost();
                    return;
                }

                const QRegularExpression lengthPattern(
                    QStringLiteral("Content-Length:\\s*(\\d+)"),
                    QRegularExpression::CaseInsensitiveOption
                );
                const auto match = lengthPattern.match(QString::fromLatin1(headers));
                if (!match.hasMatch()) return;
                const int contentLength = match.captured(1).toInt();
                const int bodyStart = headerEnd + 4;
                if (buffer->size() < bodyStart + contentLength) return;

                capturedBody = buffer->mid(bodyStart, contentLength);
                const QByteArray responseBody = testControlResponse(QJsonObject{
                    {QStringLiteral("accepted"), 2},
                    {QStringLiteral("failed"), 1},
                    {QStringLiteral("failures"), QJsonArray{
                        QJsonObject{
                            {QStringLiteral("title"), QStringLiteral("Unavailable clip")},
                            {QStringLiteral("error"), QStringLiteral("unsupported format")},
                        },
                    }},
                });
                socket->write(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                    + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                );
                socket->disconnectFromHost();
            });
        }
    });

    NovaApiClient client;
    client.setBaseUrl(QUrl(QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort())));
    QSignalSpy playlistCreatedSpy(&client, &NovaApiClient::mediaPlaylistDownloadsCreated);
    QSignalSpy capabilitySpy(&client, &NovaApiClient::engineManagementChanged);
    client.refreshEngineCapabilities();
    QTRY_VERIFY_WITH_TIMEOUT(capabilitySpy.count() >= 1, 3000);

    const QVariantMap options{
        {QStringLiteral("mode"), QStringLiteral("video")},
        {QStringLiteral("quality"), QStringLiteral("1080p")},
        {QStringLiteral("formatSelector"), QStringLiteral("bv*+ba/b")},
        {QStringLiteral("formatSort"), QStringLiteral("res,codec:avc:m4a")},
        {QStringLiteral("audioFormat"), QStringLiteral("m4a")},
        {QStringLiteral("bitrate"), QStringLiteral("320K")},
        {QStringLiteral("outputTemplate"), QStringLiteral("%(title)s.%(ext)s")},
        {QStringLiteral("playlist"), true},
        {QStringLiteral("playlistItems"), QStringLiteral("1,3,5")},
        {QStringLiteral("subtitles"), true},
        {QStringLiteral("subtitleLanguages"), QStringLiteral("en,ar")},
        {QStringLiteral("autoSubtitles"), true},
        {QStringLiteral("embedSubtitles"), true},
        {QStringLiteral("writeThumbnail"), true},
        {QStringLiteral("embedThumbnail"), true},
        {QStringLiteral("writeInfoJson"), true},
        {QStringLiteral("writeDescription"), true},
        {QStringLiteral("splitChapters"), true},
        {QStringLiteral("sponsorBlock"), QStringLiteral("sponsor,selfpromo")},
        {QStringLiteral("proxy"), QStringLiteral("https://8.8.8.8:8080")},
        {QStringLiteral("sourceAddress"), QStringLiteral("192.0.2.10")},
        {QStringLiteral("cookiesFromBrowser"), QStringLiteral("firefox")},
        {QStringLiteral("userAgent"), QStringLiteral("NOVA-Media-Test")},
        {QStringLiteral("referer"), QStringLiteral("https://origin.test/page")},
        {QStringLiteral("headers"), QStringLiteral("X-Test: one\nX-Trace: two")},
        {QStringLiteral("cookies"), QStringLiteral("sid=abc")},
        {QStringLiteral("rateLimitKbs"), 512},
        {QStringLiteral("retries"), 7},
        {QStringLiteral("fragmentRetries"), 9},
        {QStringLiteral("concurrentFragments"), 4},
        {QStringLiteral("sleepIntervalSec"), 2},
        {QStringLiteral("maxSleepIntervalSec"), 5},
        {QStringLiteral("downloadSections"), QStringLiteral("*00:01:00-00:03:00")},
        {QStringLiteral("matchFilter"), QStringLiteral("duration < 3600")},
        {QStringLiteral("remuxFormat"), QStringLiteral("mp4")}
    };

    client.createMediaDownload(
        QStringLiteral("https://example.test/watch?v=abc"),
        QStringLiteral("Media title"),
        QStringLiteral("/tmp/NOVA"),
        options,
        false
    );

    QTRY_VERIFY_WITH_TIMEOUT(!capturedBody.isEmpty(), 3000);
    QTRY_COMPARE_WITH_TIMEOUT(playlistCreatedSpy.count(), 1, 3000);
    QVERIFY(capturedRequestLine.startsWith("POST /api/v1/commands "));
    QCOMPARE(playlistCreatedSpy.at(0).at(0).toInt(), 2);
    QCOMPARE(playlistCreatedSpy.at(0).at(1).toInt(), 1);
    QVERIFY(playlistCreatedSpy.at(0).at(2).toString().contains(QStringLiteral("Unavailable clip")));
    const QJsonObject command = controlCommandFromBody(capturedBody);
    QCOMPARE(command.value(QStringLiteral("type")).toString(), QStringLiteral("addMediaPlaylist"));
    const QJsonObject body = command.value(QStringLiteral("request")).toObject();
    QCOMPARE(body.value(QStringLiteral("fileType")).toString(), QStringLiteral("video"));
    QVERIFY(!body.value(QStringLiteral("startImmediately")).toBool());

    const QJsonObject media = body.value(QStringLiteral("mediaOptions")).toObject();
    QCOMPARE(media.value(QStringLiteral("formatSelector")).toString(), QStringLiteral("bv*+ba/b"));
    QCOMPARE(media.value(QStringLiteral("formatSort")).toString(), QStringLiteral("res,codec:avc:m4a"));
    QCOMPARE(media.value(QStringLiteral("downloadSections")).toString(), QStringLiteral("*00:01:00-00:03:00"));
    QCOMPARE(media.value(QStringLiteral("matchFilter")).toString(), QStringLiteral("duration < 3600"));
    QCOMPARE(media.value(QStringLiteral("remuxFormat")).toString(), QStringLiteral("mp4"));
    QCOMPARE(media.value(QStringLiteral("sponsorBlock")).toString(), QStringLiteral("sponsor,selfpromo"));
    QCOMPARE(media.value(QStringLiteral("proxy")).toString(), QStringLiteral("https://8.8.8.8:8080"));
    QCOMPARE(media.value(QStringLiteral("sourceAddress")).toString(), QStringLiteral("192.0.2.10"));
    QCOMPARE(media.value(QStringLiteral("cookiesFromBrowser")).toString(), QStringLiteral("firefox"));
    QCOMPARE(media.value(QStringLiteral("headers")).toString(), QStringLiteral("X-Test: one\nX-Trace: two"));
    QCOMPARE(media.value(QStringLiteral("cookies")).toString(), QStringLiteral("sid=abc"));
    QCOMPARE(media.value(QStringLiteral("rateLimitKbs")).toInt(), 512);
    QCOMPARE(media.value(QStringLiteral("retries")).toInt(), 7);
    QCOMPARE(media.value(QStringLiteral("fragmentRetries")).toInt(), 9);
    QCOMPARE(media.value(QStringLiteral("concurrentFragments")).toInt(), 4);
    QCOMPARE(media.value(QStringLiteral("sleepIntervalSec")).toInt(), 2);
    QCOMPARE(media.value(QStringLiteral("maxSleepIntervalSec")).toInt(), 5);
    QVERIFY(media.value(QStringLiteral("autoSubtitles")).toBool());
    QVERIFY(media.value(QStringLiteral("splitChapters")).toBool());
}

void NativeParityTests::mediaDownloadHonorsRuntimeCapabilities() {
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));

    QByteArray capturedBody;
    connect(&server, &QTcpServer::newConnection, &server, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            auto *buffer = new QByteArray();
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            QObject::connect(socket, &QTcpSocket::disconnected, socket, [buffer]() { delete buffer; });
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket, buffer, &capturedBody]() {
                buffer->append(socket->readAll());
                const int headerEnd = buffer->indexOf("\r\n\r\n");
                if (headerEnd < 0) return;
                const QByteArray headers = buffer->left(headerEnd);
                const QByteArray requestLine = headers.left(headers.indexOf("\r\n"));

                if (requestLine.startsWith("GET /api/engines/capabilities ")) {
                    const QByteArray responseBody = testEngineCapabilities(
                        {QStringLiteral("addMediaDownload")},
                        {},
                        {
                            QStringLiteral("mode"), QStringLiteral("quality"),
                            QStringLiteral("formatSelector"), QStringLiteral("headers"),
                            QStringLiteral("retries"), QStringLiteral("cookies"),
                            QStringLiteral("remuxFormat"),
                        }
                    );
                    socket->write(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                        + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                    );
                    socket->disconnectFromHost();
                    return;
                }

                if (requestLine.startsWith("GET /api/downloads ")) {
                    const QByteArray responseBody = "[]";
                    socket->write(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                        + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                    );
                    socket->disconnectFromHost();
                    return;
                }
                if (requestLine.startsWith("GET /api/engine/queue ")) {
                    const QByteArray responseBody =
                        "{\"ok\":true,\"entries\":[],\"active_count\":0,\"total_bandwidth_kbps\":0,\"next_to_start\":null}";
                    socket->write(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                        + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                    );
                    socket->disconnectFromHost();
                    return;
                }

                const QRegularExpression lengthPattern(
                    QStringLiteral("Content-Length:\\s*(\\d+)"),
                    QRegularExpression::CaseInsensitiveOption
                );
                const auto match = lengthPattern.match(QString::fromLatin1(headers));
                if (!match.hasMatch()) return;
                const int contentLength = match.captured(1).toInt();
                const int bodyStart = headerEnd + 4;
                if (buffer->size() < bodyStart + contentLength) return;

                capturedBody = buffer->mid(bodyStart, contentLength);
                const QByteArray responseBody = testControlResponse(QJsonObject{
                    {QStringLiteral("id"), QStringLiteral("media-task-2")},
                });
                socket->write(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                    + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                );
                socket->disconnectFromHost();
            });
        }
    });

    NovaApiClient client;
    client.setBaseUrl(QUrl(QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort())));

    QSignalSpy capabilitySpy(&client, &NovaApiClient::engineManagementChanged);
    client.refreshEngineCapabilities();
    QTRY_VERIFY_WITH_TIMEOUT(capabilitySpy.count() >= 1, 3000);

    QVERIFY(client.mediaOptionSupported(QStringLiteral("formatSelector")));
    QVERIFY(client.mediaOptionSupported(QStringLiteral("headers")));
    QVERIFY(client.mediaOptionSupported(QStringLiteral("retries")));
    QVERIFY(client.mediaOptionSupported(QStringLiteral("cookies")));
    QVERIFY(client.mediaOptionSupported(QStringLiteral("remuxFormat")));
    QVERIFY(!client.mediaOptionSupported(QStringLiteral("proxy")));

    client.createMediaDownload(
        QStringLiteral("https://example.test/watch?v=abc"),
        QStringLiteral("Capability test"),
        QString(),
        QVariantMap{
            {QStringLiteral("mode"), QStringLiteral("video")},
            {QStringLiteral("quality"), QStringLiteral("720p")},
            {QStringLiteral("formatSelector"), QStringLiteral("bv*+ba/b")},
            {QStringLiteral("headers"), QStringLiteral("X-Test: allowed")},
            {QStringLiteral("retries"), 4},
            {QStringLiteral("proxy"), QStringLiteral("https://8.8.8.8:8080")},
            {QStringLiteral("cookies"), QStringLiteral("sid=blocked")},
            {QStringLiteral("remuxFormat"), QStringLiteral("mp4")},
            {QStringLiteral("sleepIntervalSec"), 9}
        },
        true
    );

    QTRY_VERIFY_WITH_TIMEOUT(!capturedBody.isEmpty(), 3000);
    const QJsonObject command = controlCommandFromBody(capturedBody);
    QCOMPARE(command.value(QStringLiteral("type")).toString(), QStringLiteral("addMediaDownload"));
    const QJsonObject media = command.value(QStringLiteral("request")).toObject()
        .value(QStringLiteral("mediaOptions")).toObject();

    QCOMPARE(media.value(QStringLiteral("formatSelector")).toString(), QStringLiteral("bv*+ba/b"));
    QCOMPARE(media.value(QStringLiteral("headers")).toString(), QStringLiteral("X-Test: allowed"));
    QCOMPARE(media.value(QStringLiteral("retries")).toInt(), 4);
    QVERIFY(!media.contains(QStringLiteral("ffmpegEnabled")));
    QVERIFY(!media.contains(QStringLiteral("proxy")));
    QCOMPARE(media.value(QStringLiteral("cookies")).toString(), QStringLiteral("sid=blocked"));
    QCOMPARE(media.value(QStringLiteral("remuxFormat")).toString(), QStringLiteral("mp4"));
    QVERIFY(!media.contains(QStringLiteral("sleepIntervalSec")));
}


void NativeParityTests::queueCatalogManagementIsDaemonBacked() {
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));

    QList<QByteArray> requestLines;
    QList<QByteArray> requestBodies;

    auto queuePayload = [](const QByteArray &queues, const QByteArray &extra = QByteArray()) {
        QByteArray body = "{\"ok\":true,\"queues\":" + queues;
        if (!extra.isEmpty()) {
            body += "," + extra;
        }
        body += "}";
        return body;
    };
    auto controlQueuePayload = [queuePayload](
        const QByteArray &queues,
        const QByteArray &extra = QByteArray()
    ) {
        return testControlResponse(QJsonDocument::fromJson(queuePayload(queues, extra)).object());
    };

    connect(&server, &QTcpServer::newConnection, &server, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            auto *buffer = new QByteArray();
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            QObject::connect(socket, &QTcpSocket::disconnected, socket, [buffer]() { delete buffer; });
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [&, socket, buffer, queuePayload, controlQueuePayload]() {
                buffer->append(socket->readAll());
                const int headerEnd = buffer->indexOf("\r\n\r\n");
                if (headerEnd < 0) return;

                const QByteArray headers = buffer->left(headerEnd);
                const QByteArray requestLine = headers.left(headers.indexOf("\r\n"));
                const QRegularExpression lengthPattern(
                    QStringLiteral("Content-Length:\\s*(\\d+)"),
                    QRegularExpression::CaseInsensitiveOption
                );
                const auto match = lengthPattern.match(QString::fromLatin1(headers));
                const int contentLength = match.hasMatch() ? match.captured(1).toInt() : 0;
                const int bodyStart = headerEnd + 4;
                if (buffer->size() < bodyStart + contentLength) return;

                const QByteArray requestBody = buffer->mid(bodyStart, contentLength);
                requestLines.append(requestLine);
                requestBodies.append(requestBody);

                const QByteArray baseQueues =
                    "[{\"id\":\"main\",\"name\":\"Main Queue\",\"maxActive\":2,\"downloadOrder\":[]},"
                    "{\"id\":\"night\",\"name\":\"Night Queue\",\"maxActive\":1,\"downloadOrder\":[]}]";
                const QByteArray withArchive =
                    "[{\"id\":\"main\",\"name\":\"Main Queue\",\"maxActive\":2,\"downloadOrder\":[]},"
                    "{\"id\":\"night\",\"name\":\"Night Queue\",\"maxActive\":1,\"downloadOrder\":[]},"
                    "{\"id\":\"archive\",\"name\":\"Archive\",\"maxActive\":3,\"limitSpeed\":true,"
                    "\"speedLimitKbs\":2048,\"retryCount\":9999,\"retryDelay\":120,\"downloadOrder\":[]}]";
                const QByteArray archiveOne =
                    "[{\"id\":\"main\",\"name\":\"Main Queue\",\"downloadOrder\":[]},"
                    "{\"id\":\"night\",\"name\":\"Night Queue\",\"downloadOrder\":[]},"
                    "{\"id\":\"archive\",\"name\":\"Archive\",\"maxActive\":3,\"downloadOrder\":[\"task-1\"]}]";
                const QByteArray archiveTwo =
                    "[{\"id\":\"main\",\"name\":\"Main Queue\",\"downloadOrder\":[]},"
                    "{\"id\":\"night\",\"name\":\"Night Queue\",\"downloadOrder\":[]},"
                    "{\"id\":\"archive\",\"name\":\"Archive\",\"maxActive\":3,\"downloadOrder\":[\"task-1\",\"task-2\"]}]";
                const QByteArray archiveReordered =
                    "[{\"id\":\"main\",\"name\":\"Main Queue\",\"downloadOrder\":[]},"
                    "{\"id\":\"archive\",\"name\":\"Archive\",\"maxActive\":3,\"downloadOrder\":[\"task-2\",\"task-1\"]},"
                    "{\"id\":\"night\",\"name\":\"Night Queue\",\"downloadOrder\":[]}]";

                QByteArray responseBody;
                const QJsonObject controlCommand = controlCommandFromBody(requestBody);
                const QString commandType = controlCommand.value(QStringLiteral("type")).toString();
                const QJsonObject controlQuery = controlQueryFromBody(requestBody);
                const QString queryType = controlQuery.value(QStringLiteral("type")).toString();
                if (requestLine.startsWith("GET /api/engines/capabilities ")) {
                    responseBody = testEngineCapabilities();
                } else if (requestLine.startsWith("POST /api/v1/queries ")
                           && queryType == QStringLiteral("listQueues")) {
                    responseBody = controlQueuePayload(baseQueues);
                } else if (requestLine.startsWith("POST /api/v1/commands ")
                           && commandType == QStringLiteral("createQueue")) {
                    responseBody = controlQueuePayload(
                        withArchive,
                        "\"queue\":{\"id\":\"archive\",\"name\":\"Archive\",\"downloadOrder\":[]}"
                    );
                } else if (requestLine.startsWith("POST /api/v1/commands ")
                           && commandType == QStringLiteral("updateQueue")) {
                    responseBody = controlQueuePayload(
                        withArchive,
                        "\"queue\":{\"id\":\"archive\",\"name\":\"Archive\",\"maxActive\":3,"
                        "\"limitSpeed\":true,\"speedLimitKbs\":2048,\"retryCount\":9999,\"retryDelay\":120,"
                        "\"downloadOrder\":[]}"
                    );
                } else if (requestLine.startsWith("POST /api/v1/commands ")
                           && commandType == QStringLiteral("moveTask")) {
                    const QString taskId = controlCommand.value(QStringLiteral("taskId")).toString();
                    responseBody = controlQueuePayload(
                        taskId == QStringLiteral("task-1") ? archiveOne : archiveTwo
                    );
                } else if (requestLine.startsWith("POST /api/v1/commands ")
                           && commandType == QStringLiteral("reorderQueueTasks")) {
                    responseBody = controlQueuePayload(archiveReordered);
                } else if (requestLine.startsWith("POST /api/v1/commands ")
                           && commandType == QStringLiteral("reorderQueues")) {
                    responseBody = controlQueuePayload(archiveReordered);
                } else if (requestLine.startsWith("POST /api/v1/commands ")
                           && commandType == QStringLiteral("deleteQueue")) {
                    responseBody = controlQueuePayload(baseQueues);
                } else if (requestLine.startsWith("GET /api/downloads ")) {
                    responseBody = "[]";
                } else if (requestLine.startsWith("GET /api/engine/queue ")) {
                    responseBody =
                        "{\"ok\":true,\"entries\":[],\"active_count\":0,"
                        "\"total_bandwidth_kbps\":0,\"next_to_start\":null}";
                } else {
                    responseBody = "{\"ok\":true}";
                }

                socket->write(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                    + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                );
                socket->disconnectFromHost();
            });
        }
    });

    NovaApiClient client;
    client.setBaseUrl(QUrl(QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort())));
    QSignalSpy catalogSpy(&client, &NovaApiClient::queueCatalogActionCompleted);
    QSignalSpy capabilitySpy(&client, &NovaApiClient::engineManagementChanged);

    client.refreshEngineCapabilities();
    QTRY_VERIFY_WITH_TIMEOUT(capabilitySpy.count() >= 1, 3000);
    client.refreshQueueCatalog();
    QTRY_COMPARE_WITH_TIMEOUT(client.queueCatalog().size(), 2, 3000);

    client.createQueue(QStringLiteral("Archive"));
    QTRY_VERIFY_WITH_TIMEOUT(catalogSpy.count() >= 1, 3000);
    QCOMPARE(catalogSpy.at(0).at(0).toString(), QStringLiteral("create"));
    QCOMPARE(catalogSpy.at(0).at(1).toString(), QStringLiteral("archive"));

    client.updateQueue(QVariantMap{
        {QStringLiteral("id"), QStringLiteral("archive")},
        {QStringLiteral("name"), QStringLiteral("Archive")},
        {QStringLiteral("maxActive"), 3},
        {QStringLiteral("limitSpeed"), true},
        {QStringLiteral("speedLimitKbs"), 2048},
        {QStringLiteral("retryCount"), 9999},
        {QStringLiteral("retryDelay"), 120}
    });
    QTRY_VERIFY_WITH_TIMEOUT(catalogSpy.count() >= 2, 3000);

    client.moveTaskToQueue(QStringLiteral("task-1"), QStringLiteral("archive"));
    QTRY_VERIFY_WITH_TIMEOUT(catalogSpy.count() >= 3, 3000);
    client.moveTaskToQueue(QStringLiteral("task-2"), QStringLiteral("archive"));
    QTRY_VERIFY_WITH_TIMEOUT(catalogSpy.count() >= 4, 3000);

    client.moveQueueTask(QStringLiteral("archive"), QStringLiteral("task-2"), -1);
    QTRY_VERIFY_WITH_TIMEOUT(catalogSpy.count() >= 5, 3000);
    const QVariantMap archiveAfterTaskReorder = client.queueCatalog().at(1).toMap();
    QCOMPARE(
        archiveAfterTaskReorder.value(QStringLiteral("downloadOrder")).toStringList(),
        QStringList({QStringLiteral("task-2"), QStringLiteral("task-1")})
    );

    client.moveQueue(QStringLiteral("archive"), -1);
    QTRY_VERIFY_WITH_TIMEOUT(catalogSpy.count() >= 6, 3000);
    QCOMPARE(client.queueCatalog().at(1).toMap().value(QStringLiteral("id")).toString(),
             QStringLiteral("archive"));

    client.deleteQueue(QStringLiteral("archive"));
    QTRY_VERIFY_WITH_TIMEOUT(catalogSpy.count() >= 7, 3000);
    QTRY_COMPARE_WITH_TIMEOUT(client.queueCatalog().size(), 2, 3000);

    bool sawCreate = false;
    bool sawUpdate = false;
    bool sawQueueReorder = false;
    bool sawTaskReorder = false;
    bool sawMove = false;
    bool sawDelete = false;
    for (int i = 0; i < requestLines.size(); ++i) {
        const QByteArray &line = requestLines.at(i);
        const QJsonObject command = controlCommandFromBody(requestBodies.at(i));
        const QString commandType = command.value(QStringLiteral("type")).toString();
        if (line.startsWith("POST /api/v1/commands ")
            && commandType == QStringLiteral("createQueue")) {
            sawCreate = command.value(QStringLiteral("name")).toString() == QStringLiteral("Archive");
        } else if (commandType == QStringLiteral("updateQueue")) {
            const QJsonObject queue = command.value(QStringLiteral("queue")).toObject();
            sawUpdate = queue.value(QStringLiteral("retryCount")).toInt() == 9999
                && queue.value(QStringLiteral("speedLimitKbs")).toInt() == 2048;
        } else if (commandType == QStringLiteral("reorderQueues")) {
            sawQueueReorder = command.value(QStringLiteral("queueIds")).isArray();
        } else if (commandType == QStringLiteral("reorderQueueTasks")) {
            const QJsonArray taskIds = command.value(QStringLiteral("taskIds")).toArray();
            sawTaskReorder = taskIds == QJsonArray{QStringLiteral("task-2"), QStringLiteral("task-1")};
        } else if (commandType == QStringLiteral("moveTask")) {
            sawMove = command.value(QStringLiteral("taskId")).toString() == QStringLiteral("task-1");
        } else if (commandType == QStringLiteral("deleteQueue")) {
            sawDelete = command.value(QStringLiteral("queueId")).toString() == QStringLiteral("archive");
        }
    }

    QVERIFY(sawCreate);
    QVERIFY(sawUpdate);
    QVERIFY(sawQueueReorder);
    QVERIFY(sawTaskReorder);
    QVERIFY(sawMove);
    QVERIFY(sawDelete);
}

void NativeParityTests::queueStartStopIsDaemonBacked() {
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));

    QList<QByteArray> requestLines;
    QList<QByteArray> requestBodies;
    connect(&server, &QTcpServer::newConnection, &server, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            auto *buffer = new QByteArray();
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            QObject::connect(socket, &QTcpSocket::disconnected, socket, [buffer]() { delete buffer; });
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [&, socket, buffer]() {
                buffer->append(socket->readAll());
                const int headerEnd = buffer->indexOf("\r\n\r\n");
                if (headerEnd < 0) return;

                const QByteArray headers = buffer->left(headerEnd);
                const QByteArray requestLine = headers.left(headers.indexOf("\r\n"));
                const QRegularExpression lengthPattern(
                    QStringLiteral("Content-Length:\\s*(\\d+)"),
                    QRegularExpression::CaseInsensitiveOption
                );
                const auto match = lengthPattern.match(QString::fromLatin1(headers));
                const int contentLength = match.hasMatch() ? match.captured(1).toInt() : 0;
                const int bodyStart = headerEnd + 4;
                if (buffer->size() < bodyStart + contentLength) return;
                requestLines.append(requestLine);
                const QByteArray requestBody = buffer->mid(bodyStart, contentLength);
                requestBodies.append(requestBody);
                const QJsonObject command = controlCommandFromBody(requestBody);
                const QJsonObject query = controlQueryFromBody(requestBody);

                QByteArray responseBody;
                if (requestLine.startsWith("GET /api/engines/capabilities ")) {
                    responseBody = testEngineCapabilities();
                } else if (requestLine.startsWith("POST /api/v1/queries ")
                           && query.value(QStringLiteral("type")).toString() == QStringLiteral("listQueues")) {
                    responseBody = testControlResponse(QJsonObject{
                        {QStringLiteral("queues"), QJsonArray{
                            QJsonObject{
                                {QStringLiteral("id"), QStringLiteral("main")},
                                {QStringLiteral("name"), QStringLiteral("Main Queue")},
                                {QStringLiteral("maxActive"), 2},
                                {QStringLiteral("downloadOrder"), QJsonArray{
                                    QStringLiteral("active"), QStringLiteral("queued"), QStringLiteral("paused")
                                }},
                            },
                        }},
                    });
                } else if (requestLine.startsWith("GET /api/downloads ")) {
                    responseBody =
                        "["
                        "{\"id\":\"active\",\"name\":\"active.bin\",\"queueId\":\"main\",\"status\":\"downloading\"},"
                        "{\"id\":\"queued\",\"name\":\"queued.bin\",\"queueId\":\"main\",\"status\":\"queued\"},"
                        "{\"id\":\"paused\",\"name\":\"paused.bin\",\"queueId\":\"main\",\"status\":\"paused\"}"
                        "]";
                } else if (requestLine.startsWith("POST /api/v1/commands ")
                           && (command.value(QStringLiteral("type")).toString() == QStringLiteral("startQueue")
                               || command.value(QStringLiteral("type")).toString() == QStringLiteral("stopQueue"))) {
                    responseBody = testControlResponse(QJsonObject{
                        {QStringLiteral("queues"), QJsonArray{
                            QJsonObject{
                                {QStringLiteral("id"), QStringLiteral("main")},
                                {QStringLiteral("name"), QStringLiteral("Main Queue")},
                                {QStringLiteral("maxActive"), 2},
                                {QStringLiteral("downloadOrder"), QJsonArray{
                                    QStringLiteral("active"), QStringLiteral("queued"), QStringLiteral("paused")
                                }},
                            },
                        }},
                    });
                } else if (requestLine.startsWith("GET /api/engine/queue ")) {
                    responseBody =
                        "{\"ok\":true,\"entries\":[],\"active_count\":1,"
                        "\"total_bandwidth_kbps\":0,\"next_to_start\":\"queued\"}";
                } else {
                    responseBody = "{\"ok\":true}";
                }

                socket->write(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                    + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                );
                socket->disconnectFromHost();
            });
        }
    });

    NovaApiClient client;
    client.setBaseUrl(QUrl(QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort())));
    QSignalSpy downloadsSpy(&client, &NovaApiClient::downloadsLoaded);
    QSignalSpy capabilitySpy(&client, &NovaApiClient::engineManagementChanged);
    client.refreshEngineCapabilities();
    QTRY_VERIFY_WITH_TIMEOUT(capabilitySpy.count() >= 1, 3000);
    client.refreshQueueCatalog();
    client.refreshDownloads();

    QTRY_COMPARE_WITH_TIMEOUT(client.queueCatalog().size(), 1, 3000);
    QTRY_VERIFY_WITH_TIMEOUT(downloadsSpy.count() >= 1, 3000);

    requestLines.clear();
    requestBodies.clear();
    client.startQueue(QStringLiteral("main"));
    QTRY_VERIFY_WITH_TIMEOUT(
        std::any_of(
            requestBodies.cbegin(),
            requestBodies.cend(),
            [](const QByteArray &body) {
                return controlCommandFromBody(body)
                           .value(QStringLiteral("type")).toString() == QStringLiteral("startQueue");
            }
        ),
        3000
    );

    int directTaskActions = 0;
    for (const QByteArray &line : requestLines) {
        if (line.startsWith("POST /api/downloads/")) ++directTaskActions;
    }
    QCOMPARE(directTaskActions, 0);
    QVERIFY(std::none_of(
        requestLines.cbegin(),
        requestLines.cend(),
        [](const QByteArray &line) {
            return line.startsWith("POST /api/downloads/paused/resume ");
        }
    ));

    requestLines.clear();
    requestBodies.clear();
    client.stopQueue(QStringLiteral("main"));
    QTRY_VERIFY_WITH_TIMEOUT(
        std::any_of(
            requestBodies.cbegin(),
            requestBodies.cend(),
            [](const QByteArray &body) {
                return controlCommandFromBody(body)
                           .value(QStringLiteral("type")).toString() == QStringLiteral("stopQueue");
            }
        ),
        3000
    );
}


void NativeParityTests::schedulerStatusCarriesCompletionControls() {
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));

    bool powerEnabled = true;
    bool exitRequested = true;
    QList<QByteArray> requestBodies;

    connect(&server, &QTcpServer::newConnection, &server, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            auto *buffer = new QByteArray();
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            QObject::connect(socket, &QTcpSocket::disconnected, socket, [buffer]() { delete buffer; });
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [&, socket, buffer]() {
                buffer->append(socket->readAll());
                const int headerEnd = buffer->indexOf("\r\n\r\n");
                if (headerEnd < 0) return;

                const QByteArray headers = buffer->left(headerEnd);
                const QByteArray requestLine = headers.left(headers.indexOf("\r\n"));
                const QRegularExpression lengthPattern(
                    QStringLiteral("Content-Length:\\s*(\\d+)"),
                    QRegularExpression::CaseInsensitiveOption
                );
                const auto match = lengthPattern.match(QString::fromLatin1(headers));
                const int contentLength = match.hasMatch() ? match.captured(1).toInt() : 0;
                const int bodyStart = headerEnd + 4;
                if (buffer->size() < bodyStart + contentLength) return;

                const QByteArray body = buffer->mid(bodyStart, contentLength);
                QByteArray responseBody;
                const QJsonObject command = controlCommandFromBody(body);
                const QJsonObject query = controlQueryFromBody(body);
                if (requestLine.startsWith("GET /api/engines/capabilities ")) {
                    responseBody = testEngineCapabilities();
                } else if (requestLine.startsWith("POST /api/v1/queries ")
                           && query.value(QStringLiteral("type")).toString() == QStringLiteral("listSchedules")) {
                    responseBody = testControlResponse(QJsonObject{
                        {QStringLiteral("rules"), QJsonArray{}},
                        {QStringLiteral("active_rule_ids"), QJsonArray{}},
                        {QStringLiteral("powerCommandsEnabled"), powerEnabled},
                        {QStringLiteral("exitRequested"), exitRequested},
                    });
                } else if (requestLine.startsWith("POST /api/v1/commands ")
                           && command.value(QStringLiteral("type")).toString()
                                  == QStringLiteral("setSchedulerPowerCommands")) {
                    requestBodies.append(body);
                    powerEnabled = command.value(QStringLiteral("enabled")).toBool();
                    responseBody = testControlResponse(QJsonObject{
                        {QStringLiteral("ok"), true},
                        {QStringLiteral("powerCommandsEnabled"), powerEnabled},
                    });
                } else {
                    responseBody = testControlResponse(QJsonObject{{QStringLiteral("ok"), true}});
                }

                socket->write(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                    + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                );
                socket->disconnectFromHost();
            });
        }
    });

    NovaApiClient client;
    client.setBaseUrl(QUrl(QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort())));
    QSignalSpy schedulerSpy(&client, &NovaApiClient::schedulerChanged);
    QSignalSpy exitSpy(&client, &NovaApiClient::schedulerExitRequested);
    QSignalSpy capabilitySpy(&client, &NovaApiClient::engineManagementChanged);

    client.refreshEngineCapabilities();
    QTRY_VERIFY_WITH_TIMEOUT(capabilitySpy.count() >= 1, 3000);
    client.refreshScheduler();
    QTRY_VERIFY_WITH_TIMEOUT(schedulerSpy.count() >= 1, 3000);
    QCOMPARE(client.schedulerPowerCommandsEnabled(), true);
    QCOMPARE(exitSpy.count(), 1);

    client.refreshScheduler();
    QTRY_VERIFY_WITH_TIMEOUT(schedulerSpy.count() >= 2, 3000);
    QCOMPARE(exitSpy.count(), 1);

    exitRequested = false;
    client.setSchedulerPowerCommandsEnabled(false);
    QTRY_VERIFY_WITH_TIMEOUT(schedulerSpy.count() >= 3, 3000);
    QCOMPARE(client.schedulerPowerCommandsEnabled(), false);
    QVERIFY(!requestBodies.isEmpty());
    QVERIFY(requestBodies.constLast().contains("\"enabled\":false"));
}


void NativeParityTests::advancedSettingsMigrateAndBackupSafely() {
    QTemporaryDir temp;
    QVERIFY(temp.isValid());

    const QByteArray previousDataDir = qgetenv("NOVA_NATIVE_DATA_DIR");
    qputenv("NOVA_NATIVE_DATA_DIR", temp.path().toUtf8());

    const QString configPath = temp.filePath(QStringLiteral("config.json"));
    QFile config(configPath);
    QVERIFY(config.open(QIODevice::WriteOnly | QIODevice::Truncate));
    const QJsonObject legacy{
        {
            QStringLiteral("connection"),
            QJsonObject{
                {QStringLiteral("enableProxy"), true},
                {QStringLiteral("proxyHost"), QStringLiteral("proxy.test")},
                {QStringLiteral("proxyPort"), QStringLiteral("8080")},
                {QStringLiteral("proxyUser"), QStringLiteral("alice")},
                {QStringLiteral("proxyPass"), QStringLiteral("secret")},
                {QStringLiteral("proxyType"), QStringLiteral("http")},
                {
                    QStringLiteral("speedLimiter"),
                    QJsonObject{
                        {QStringLiteral("enabled"), true},
                        {QStringLiteral("maxSpeedKbs"), 4096}
                    }
                },
                {
                    QStringLiteral("defaults"),
                    QJsonObject{
                        {QStringLiteral("timeoutSec"), 90},
                        {QStringLiteral("connectTimeoutSec"), 15},
                        {QStringLiteral("retryCount"), 7},
                        {QStringLiteral("retryDelaySec"), 9},
                        {QStringLiteral("dnsServers"), QStringLiteral("1.1.1.1,1.0.0.1")},
                        {QStringLiteral("keepaliveTimeSec"), 30},
                        {QStringLiteral("httpVersion"), QStringLiteral("2")},
                        {QStringLiteral("insecure"), true},
                        {QStringLiteral("caCert"), QStringLiteral("/tmp/ca.pem")},
                        {QStringLiteral("clientCert"), QStringLiteral("/tmp/client.pem")},
                        {QStringLiteral("clientKey"), QStringLiteral("/tmp/client.key")},
                        {QStringLiteral("tlsMin"), QStringLiteral("1.2")},
                        {QStringLiteral("ciphers"), QStringLiteral("HIGH:!aNULL")}
                    }
                }
            }
        },
        {
            QStringLiteral("extra"),
            QJsonObject{
                {QStringLiteral("videoQuality"), QStringLiteral("good")},
                {QStringLiteral("downloadSubtitles"), true},
                {QStringLiteral("subtitleLanguage"), QStringLiteral("ar,en")},
                {QStringLiteral("vpnEnabled"), true},
                {QStringLiteral("vpnMode"), QStringLiteral("bind")},
                {QStringLiteral("vpnBindAddress"), QStringLiteral("tun0")},
                {QStringLiteral("tgEnabled"), true},
                {QStringLiteral("tgBotToken"), QStringLiteral("12345:secret-token")},
                {QStringLiteral("tgChatId"), QStringLiteral("987654")},
                {QStringLiteral("tgApiBase"), QStringLiteral("https://api.telegram.org")},
                {QStringLiteral("tgFileUploadLimitMb"), 75}
            }
        },
        {
            QStringLiteral("advanced"),
            QJsonObject{
                {QStringLiteral("dynamicAllocation"), false},
                {QStringLiteral("bufferSizeKb"), 512},
                {QStringLiteral("loggingEnabled"), true},
                {QStringLiteral("logLevel"), QStringLiteral("debug")},
                {QStringLiteral("browserInterceptKeys"), QStringLiteral("Alt+Ctrl")}
            }
        },
        {
            QStringLiteral("keyboardShortcuts"),
            QJsonObject{
                {QStringLiteral("enabled"), true},
                {
                    QStringLiteral("bindings"),
                    QJsonObject{
                        {QStringLiteral("addDownload"), QStringLiteral("Ctrl+Alt+N")},
                        {QStringLiteral("openSettings"), QStringLiteral("Ctrl+Alt+,")}
                    }
                }
            }
        }
    };
    config.write(QJsonDocument(legacy).toJson(QJsonDocument::Compact));
    config.close();

    const QString settingsFile = temp.filePath(QStringLiteral("native-settings.ini"));
    NativeSettings settings(settingsFile, nullptr);
    const QVariantMap advanced = settings.advancedSettings();
    QCOMPARE(advanced.value(QStringLiteral("proxyEnabled")).toBool(), true);
    QCOMPARE(advanced.value(QStringLiteral("proxyHost")).toString(), QStringLiteral("proxy.test"));
    QCOMPARE(advanced.value(QStringLiteral("proxyPassword")).toString(), QStringLiteral("secret"));
    QCOMPARE(advanced.value(QStringLiteral("speedLimiterEnabled")).toBool(), true);
    QCOMPARE(advanced.value(QStringLiteral("speedLimitKbs")).toInt(), 4096);
    QCOMPARE(advanced.value(QStringLiteral("timeoutSec")).toInt(), 90);
    QCOMPARE(advanced.value(QStringLiteral("retryCount")).toInt(), 7);
    QCOMPARE(advanced.value(QStringLiteral("keepaliveTimeSec")).toInt(), 30);
    QCOMPARE(advanced.value(QStringLiteral("httpVersion")).toString(), QStringLiteral("2"));
    QCOMPARE(advanced.value(QStringLiteral("insecure")).toBool(), true);
    QCOMPARE(advanced.value(QStringLiteral("caCert")).toString(), QStringLiteral("/tmp/ca.pem"));
    QCOMPARE(advanced.value(QStringLiteral("clientCert")).toString(), QStringLiteral("/tmp/client.pem"));
    QCOMPARE(advanced.value(QStringLiteral("clientKey")).toString(), QStringLiteral("/tmp/client.key"));
    QCOMPARE(advanced.value(QStringLiteral("tlsMin")).toString(), QStringLiteral("1.2"));
    QCOMPARE(advanced.value(QStringLiteral("ciphers")).toString(), QStringLiteral("HIGH:!aNULL"));
    QCOMPARE(advanced.value(QStringLiteral("videoQuality")).toString(), QStringLiteral("good"));
    QCOMPARE(advanced.value(QStringLiteral("vpnBindAddress")).toString(), QStringLiteral("tun0"));
    QCOMPARE(advanced.value(QStringLiteral("bufferSizeKb")).toInt(), 512);
    QCOMPARE(advanced.value(QStringLiteral("loggingEnabled")).toBool(), true);
    QCOMPARE(advanced.value(QStringLiteral("logLevel")).toString(), QStringLiteral("debug"));
    QCOMPARE(advanced.value(QStringLiteral("browserInterceptKeys")).toString(), QStringLiteral("Alt+Ctrl"));
    QCOMPARE(advanced.value(QStringLiteral("telegramEnabled")).toBool(), true);
    QCOMPARE(advanced.value(QStringLiteral("telegramToken")).toString(), QStringLiteral("12345:secret-token"));
    QCOMPARE(advanced.value(QStringLiteral("telegramChatId")).toString(), QStringLiteral("987654"));
    QCOMPARE(
        settings.shortcutBindings().value(QStringLiteral("addDownload")).toString(),
        QStringLiteral("Ctrl+Alt+N")
    );

    const QString backupPath = temp.filePath(QStringLiteral("settings-backup.json"));
    QVERIFY(settings.exportBackup(backupPath));
    QFile backup(backupPath);
    QVERIFY(backup.open(QIODevice::ReadOnly));
    const QJsonObject backupRoot = QJsonDocument::fromJson(backup.readAll()).object();
    backup.close();
    QCOMPARE(
        backupRoot.value(QStringLiteral("schema")).toString(),
        QStringLiteral("nova-native-settings-v1")
    );
    const QJsonObject backedAdvanced = backupRoot
        .value(QStringLiteral("settings"))
        .toObject()
        .value(QStringLiteral("advanced"))
        .toObject();
    QVERIFY(!backedAdvanced.contains(QStringLiteral("proxyPassword")));
    QVERIFY(!backedAdvanced.contains(QStringLiteral("telegramToken")));
    QCOMPARE(
        backedAdvanced.value(QStringLiteral("proxyHost")).toString(),
        QStringLiteral("proxy.test")
    );

    settings.setAdvancedValue(QStringLiteral("proxyHost"), QStringLiteral("changed.test"));
    settings.setShortcutBinding(QStringLiteral("addDownload"), QStringLiteral("Alt+N"));
    QVERIFY(settings.importBackup(backupPath));
    QCOMPARE(
        settings.advancedSettings().value(QStringLiteral("proxyHost")).toString(),
        QStringLiteral("proxy.test")
    );
    QCOMPARE(
        settings.shortcutBindings().value(QStringLiteral("addDownload")).toString(),
        QStringLiteral("Ctrl+Alt+N")
    );
    // Backup intentionally cannot overwrite a locally stored secret.
    QCOMPARE(
        settings.advancedSettings().value(QStringLiteral("proxyPassword")).toString(),
        QStringLiteral("secret")
    );

    QVERIFY(settings.daemonMigrationPending(QStringLiteral("telegram")));
    settings.completeDaemonMigration(QStringLiteral("telegram"));
    QVERIFY(!settings.daemonMigrationPending(QStringLiteral("telegram")));
    QCOMPARE(
        settings.advancedSettings().value(QStringLiteral("telegramToken")).toString(),
        QString()
    );

    if (previousDataDir.isEmpty()) {
        qunsetenv("NOVA_NATIVE_DATA_DIR");
    } else {
        qputenv("NOVA_NATIVE_DATA_DIR", previousDataDir);
    }
}

void NativeParityTests::advancedDownloadCarriesNetworkDefaults() {
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));

    QByteArray capturedBody;
    connect(&server, &QTcpServer::newConnection, &server, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            auto *buffer = new QByteArray();
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            QObject::connect(socket, &QTcpSocket::disconnected, socket, [buffer]() { delete buffer; });
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [&, socket, buffer]() {
                buffer->append(socket->readAll());
                const int headerEnd = buffer->indexOf("\r\n\r\n");
                if (headerEnd < 0) return;

                const QByteArray headers = buffer->left(headerEnd);
                const QByteArray requestLine = headers.left(headers.indexOf("\r\n"));
                const QRegularExpression lengthPattern(
                    QStringLiteral("Content-Length:\\s*(\\d+)"),
                    QRegularExpression::CaseInsensitiveOption
                );
                const auto match = lengthPattern.match(QString::fromLatin1(headers));
                const int contentLength = match.hasMatch() ? match.captured(1).toInt() : 0;
                const int bodyStart = headerEnd + 4;
                if (buffer->size() < bodyStart + contentLength) return;

                if (requestLine.startsWith("GET /api/engines/capabilities ")) {
                    const QByteArray responseBody = testEngineCapabilities();
                    socket->write(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                        + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                    );
                    socket->disconnectFromHost();
                    return;
                }

                const QByteArray requestBody = buffer->mid(bodyStart, contentLength);
                if (requestLine.startsWith("POST /api/v1/commands ")) {
                    capturedBody = requestBody;
                }

                const QByteArray responseBody = requestLine.startsWith("POST /api/v1/commands ")
                    ? testControlResponse(QJsonObject{{QStringLiteral("id"), QStringLiteral("task-network")}})
                    : QByteArray("[]");
                socket->write(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                    + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                );
                socket->disconnectFromHost();
            });
        }
    });

    NovaApiClient client;
    client.setBaseUrl(QUrl(QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort())));
    QSignalSpy createdSpy(&client, &NovaApiClient::downloadCreated);
    QSignalSpy capabilitySpy(&client, &NovaApiClient::engineManagementChanged);
    client.refreshEngineCapabilities();
    QTRY_VERIFY_WITH_TIMEOUT(capabilitySpy.count() >= 1, 3000);

    client.createDownloadAdvanced(
        QStringLiteral("https://example.test/file.bin"),
        QStringLiteral("file.bin"),
        QStringLiteral("/tmp/file.bin"),
        true,
        0,
        QVariantMap{
            {QStringLiteral("proxy"), QStringLiteral("http://proxy.test:8080")},
            {QStringLiteral("proxyUser"), QStringLiteral("alice")},
            {QStringLiteral("proxyPassword"), QStringLiteral("secret")},
            {QStringLiteral("timeoutSec"), 90},
            {QStringLiteral("connectTimeoutSec"), 15},
            {QStringLiteral("retryCount"), 7},
            {QStringLiteral("retryDelaySec"), 9},
            {QStringLiteral("dnsServers"), QStringLiteral("1.1.1.1,1.0.0.1")},
            {QStringLiteral("userAgent"), QStringLiteral("NOVA-Test")},
            {QStringLiteral("bufferSize"), 524288},
            {QStringLiteral("keepaliveTimeSec"), 30},
            {QStringLiteral("httpVersion"), QStringLiteral("2")},
            {QStringLiteral("insecure"), true},
            {QStringLiteral("caCert"), QStringLiteral("/tmp/ca.pem")},
            {QStringLiteral("cert"), QStringLiteral("/tmp/client.pem")},
            {QStringLiteral("key"), QStringLiteral("/tmp/client.key")},
            {QStringLiteral("tlsMin"), QStringLiteral("1.2")},
            {QStringLiteral("ciphers"), QStringLiteral("HIGH:!aNULL")}
        }
    );

    QTRY_VERIFY_WITH_TIMEOUT(createdSpy.count() >= 1, 3000);
    QVERIFY(!capturedBody.isEmpty());

    const QJsonObject command = controlCommandFromBody(capturedBody);
    QCOMPARE(command.value(QStringLiteral("type")).toString(), QStringLiteral("addDownload"));
    const QJsonObject body = command.value(QStringLiteral("request")).toObject();
    QCOMPARE(body.value(QStringLiteral("connections")).toInt(), 0);
    const QJsonObject options = body.value(QStringLiteral("directOptions")).toObject();
    QCOMPARE(options.value(QStringLiteral("proxy")).toString(), QStringLiteral("http://proxy.test:8080"));
    QCOMPARE(options.value(QStringLiteral("proxyUser")).toString(), QStringLiteral("alice"));
    QCOMPARE(options.value(QStringLiteral("timeoutSec")).toInt(), 90);
    QCOMPARE(options.value(QStringLiteral("retryCount")).toInt(), 7);
    QCOMPARE(options.value(QStringLiteral("dnsServers")).toString(), QStringLiteral("1.1.1.1,1.0.0.1"));
    QCOMPARE(options.value(QStringLiteral("bufferSize")).toInt(), 524288);
    QCOMPARE(options.value(QStringLiteral("keepaliveTimeSec")).toInt(), 30);
    QCOMPARE(options.value(QStringLiteral("httpVersion")).toString(), QStringLiteral("2"));
    QCOMPARE(options.value(QStringLiteral("insecure")).toBool(), true);
    QCOMPARE(options.value(QStringLiteral("caCert")).toString(), QStringLiteral("/tmp/ca.pem"));
    QCOMPARE(options.value(QStringLiteral("cert")).toString(), QStringLiteral("/tmp/client.pem"));
    QCOMPARE(options.value(QStringLiteral("key")).toString(), QStringLiteral("/tmp/client.key"));
    QCOMPARE(options.value(QStringLiteral("tlsMin")).toString(), QStringLiteral("1.2"));
    QCOMPARE(options.value(QStringLiteral("ciphers")).toString(), QStringLiteral("HIGH:!aNULL"));
}

void NativeParityTests::settingsServicesReachDaemon() {
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));

    QList<QByteArray> requestLines;
    QList<QByteArray> requestBodies;
    connect(&server, &QTcpServer::newConnection, &server, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            auto *buffer = new QByteArray();
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            QObject::connect(socket, &QTcpSocket::disconnected, socket, [buffer]() { delete buffer; });
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [&, socket, buffer]() {
                buffer->append(socket->readAll());
                const int headerEnd = buffer->indexOf("\r\n\r\n");
                if (headerEnd < 0) return;

                const QByteArray headers = buffer->left(headerEnd);
                const QByteArray requestLine = headers.left(headers.indexOf("\r\n"));
                const QRegularExpression lengthPattern(
                    QStringLiteral("Content-Length:\\s*(\\d+)"),
                    QRegularExpression::CaseInsensitiveOption
                );
                const auto match = lengthPattern.match(QString::fromLatin1(headers));
                const int contentLength = match.hasMatch() ? match.captured(1).toInt() : 0;
                const int bodyStart = headerEnd + 4;
                if (buffer->size() < bodyStart + contentLength) return;

                const QByteArray body = buffer->mid(bodyStart, contentLength);
                requestLines.append(requestLine);
                requestBodies.append(body);

                QByteArray responseBody;
                if (requestLine.startsWith("GET /api/external-tools ")) {
                    responseBody =
                        "{\"tools\":[{\"toolId\":\"ffmpeg\",\"status\":\"Installed\",\"version\":\"7.0\"}]}";
                } else if (requestLine.startsWith("GET /api/telegram/config ")) {
                    responseBody =
                        "{\"enabled\":true,\"token\":\"1234...abcd\",\"hasToken\":true,"
                        "\"chatId\":123456,\"apiBase\":\"https://api.telegram.org\",\"fileUploadLimitMb\":50}";
                } else if (requestLine.startsWith("POST /api/dns/ping-all ")) {
                    responseBody =
                        "{\"results\":[{\"name\":\"Cloudflare\",\"ip\":\"1.1.1.1\",\"latencyMs\":12.5}]}";
                } else if (requestLine.startsWith("POST /api/telegram/config ")) {
                    responseBody = "{\"ok\":true}";
                } else if (requestLine.startsWith("POST /api/telegram/test ")) {
                    responseBody = "{\"ok\":true}";
                } else if (requestLine.startsWith("POST /api/external-tools/ffmpeg/health ")) {
                    responseBody = "{\"ok\":true,\"status\":\"Installed\"}";
                } else if (requestLine.startsWith("GET /api/engines/capabilities ")) {
                    responseBody = "{\"engines\":{}}";
                } else {
                    responseBody = "{\"ok\":true}";
                }

                socket->write(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                    + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                );
                socket->disconnectFromHost();
            });
        }
    });

    NovaApiClient client;
    client.setBaseUrl(QUrl(QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort())));
    QSignalSpy servicesSpy(&client, &NovaApiClient::settingsServicesChanged);
    QSignalSpy actionSpy(&client, &NovaApiClient::settingsServiceActionCompleted);

    client.refreshSettingsServices();
    QTRY_VERIFY_WITH_TIMEOUT(servicesSpy.count() >= 1, 3000);
    QVERIFY(client.externalTools().isEmpty());
    QCOMPARE(client.telegramConfig().value(QStringLiteral("hasToken")).toBool(), true);

    client.pingDnsProviders();
    QTRY_VERIFY_WITH_TIMEOUT(client.dnsResults().size() == 1, 3000);
    QCOMPARE(
        client.dnsResults().first().toMap().value(QStringLiteral("ip")).toString(),
        QStringLiteral("1.1.1.1")
    );

    client.updateTelegramConfig(QVariantMap{
        {QStringLiteral("enabled"), true},
        {QStringLiteral("chatId"), 987654},
        {QStringLiteral("apiBase"), QStringLiteral("https://api.telegram.org")},
        {QStringLiteral("fileUploadLimitMb"), 100}
    });
    client.testTelegram();
    client.runExternalToolAction(QStringLiteral("ffmpeg"), QStringLiteral("health"));

    QTRY_VERIFY_WITH_TIMEOUT(actionSpy.count() >= 3, 3000);
    QTRY_COMPARE_WITH_TIMEOUT(client.externalTools().size(), 1, 3000);

    bool sawTelegramSave = false;
    bool sawTelegramTest = false;
    bool sawToolHealth = false;
    for (int i = 0; i < requestLines.size(); ++i) {
        const QByteArray line = requestLines.at(i);
        if (line.startsWith("POST /api/telegram/config ")) {
            sawTelegramSave = requestBodies.at(i).contains("\"chatId\":987654");
        } else if (line.startsWith("POST /api/telegram/test ")) {
            sawTelegramTest = true;
        } else if (line.startsWith("POST /api/external-tools/ffmpeg/health ")) {
            sawToolHealth = true;
        }
    }
    QVERIFY(sawTelegramSave);
    QVERIFY(sawTelegramTest);
    QVERIFY(sawToolHealth);
}


void NativeParityTests::bulkShortcutActionsRespectTaskLifecycle() {
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));

    QList<QByteArray> requestLines;
    QList<QByteArray> requestBodies;
    connect(&server, &QTcpServer::newConnection, &server, [&]() {
        while (server.hasPendingConnections()) {
            QTcpSocket *socket = server.nextPendingConnection();
            auto *buffer = new QByteArray();
            QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            QObject::connect(socket, &QTcpSocket::disconnected, socket, [buffer]() { delete buffer; });
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [&, socket, buffer]() {
                buffer->append(socket->readAll());
                const int headerEnd = buffer->indexOf("\r\n\r\n");
                if (headerEnd < 0) return;

                const QByteArray headers = buffer->left(headerEnd);
                const QByteArray requestLine = headers.left(headers.indexOf("\r\n"));
                const QRegularExpression lengthPattern(
                    QStringLiteral("Content-Length:\\s*(\\d+)"),
                    QRegularExpression::CaseInsensitiveOption
                );
                const auto match = lengthPattern.match(QString::fromLatin1(headers));
                const int contentLength = match.hasMatch() ? match.captured(1).toInt() : 0;
                const int bodyStart = headerEnd + 4;
                if (buffer->size() < bodyStart + contentLength) return;

                requestLines.append(requestLine);
                const QByteArray requestBody = buffer->mid(bodyStart, contentLength);
                requestBodies.append(requestBody);
                QByteArray responseBody;
                if (requestLine.startsWith("GET /api/engines/capabilities ")) {
                    responseBody = testEngineCapabilities();
                } else if (requestLine.startsWith("GET /api/downloads ")) {
                    responseBody =
                        "["
                        "{\"id\":\"active\",\"name\":\"active.bin\",\"status\":\"downloading\"},"
                        "{\"id\":\"paused\",\"name\":\"paused.bin\",\"status\":\"paused\"},"
                        "{\"id\":\"failed\",\"name\":\"failed.bin\",\"status\":\"error\"},"
                        "{\"id\":\"done\",\"name\":\"done.bin\",\"status\":\"completed\"}"
                        "]";
                } else if (requestLine.startsWith("POST /api/v1/commands ")) {
                    responseBody = testControlResponse(QJsonObject{{QStringLiteral("ok"), true}});
                } else if (requestLine.startsWith("POST /api/downloads/live-task/finish ")) {
                    responseBody = "{\"ok\":true}";
                } else {
                    responseBody = "[]";
                }

                socket->write(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                    + QByteArray::number(responseBody.size()) + "\r\n\r\n" + responseBody
                );
                socket->disconnectFromHost();
            });
        }
    });

    NovaApiClient client;
    client.setBaseUrl(QUrl(QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort())));
    QSignalSpy downloadsSpy(&client, &NovaApiClient::downloadsLoaded);
    QSignalSpy capabilitySpy(&client, &NovaApiClient::engineManagementChanged);
    client.refreshEngineCapabilities();
    QTRY_VERIFY_WITH_TIMEOUT(capabilitySpy.count() >= 1, 3000);
    client.refreshDownloads();
    QTRY_VERIFY_WITH_TIMEOUT(downloadsSpy.count() >= 1, 3000);

    const auto hasTaskCommand = [&requestBodies](const QString &type, const QString &taskId) {
        return std::any_of(requestBodies.cbegin(), requestBodies.cend(), [&](const QByteArray &body) {
            const QJsonObject command = controlCommandFromBody(body);
            return command.value(QStringLiteral("type")).toString() == type
                && command.value(QStringLiteral("taskId")).toString() == taskId;
        });
    };

    requestLines.clear();
    requestBodies.clear();
    client.resumeAllDownloads();
    QTRY_VERIFY_WITH_TIMEOUT(
        hasTaskCommand(QStringLiteral("resumeTask"), QStringLiteral("paused"))
            && hasTaskCommand(QStringLiteral("resumeTask"), QStringLiteral("failed")),
        3000
    );
    QVERIFY(!hasTaskCommand(QStringLiteral("resumeTask"), QStringLiteral("active")));
    QVERIFY(!hasTaskCommand(QStringLiteral("resumeTask"), QStringLiteral("done")));
    QTRY_VERIFY_WITH_TIMEOUT(downloadsSpy.count() >= 3, 3000);

    requestLines.clear();
    requestBodies.clear();
    client.pauseAllDownloads();
    QTRY_VERIFY_WITH_TIMEOUT(
        hasTaskCommand(QStringLiteral("pauseTask"), QStringLiteral("active"))
            && hasTaskCommand(QStringLiteral("pauseTask"), QStringLiteral("failed")),
        3000
    );
    QVERIFY(!hasTaskCommand(QStringLiteral("pauseTask"), QStringLiteral("paused")));
    QVERIFY(!hasTaskCommand(QStringLiteral("pauseTask"), QStringLiteral("done")));
    QTRY_VERIFY_WITH_TIMEOUT(downloadsSpy.count() >= 5, 3000);

    requestLines.clear();
    requestBodies.clear();
    client.deleteCompletedDownloads();
    QTRY_VERIFY_WITH_TIMEOUT(
        hasTaskCommand(QStringLiteral("deleteTask"), QStringLiteral("done")),
        3000
    );
    QVERIFY(!hasTaskCommand(QStringLiteral("deleteTask"), QStringLiteral("active")));
    QVERIFY(!hasTaskCommand(QStringLiteral("deleteTask"), QStringLiteral("paused")));
    QVERIFY(!hasTaskCommand(QStringLiteral("deleteTask"), QStringLiteral("failed")));
    QTRY_VERIFY_WITH_TIMEOUT(downloadsSpy.count() >= 6, 3000);

    requestLines.clear();
    QSignalSpy actionSpy(&client, &NovaApiClient::taskActionCompleted);
    client.finishLiveRecording(QStringLiteral("live-task"));
    QTRY_VERIFY_WITH_TIMEOUT(
        std::any_of(
            requestLines.cbegin(),
            requestLines.cend(),
            [](const QByteArray &line) {
                return line.startsWith("POST /api/downloads/live-task/finish ");
            }
        ),
        3000
    );
    QTRY_VERIFY_WITH_TIMEOUT(actionSpy.count() >= 1, 3000);
    QCOMPARE(actionSpy.at(0).at(0).toString(), QStringLiteral("finish"));
}

QTEST_GUILESS_MAIN(NativeParityTests)
#include "NativeParityTests.moc"
