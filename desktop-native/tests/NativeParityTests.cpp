#include <QtTest>

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
#include "models/DownloadListModel.h"
#include "settings/NativeSettings.h"

class NativeParityTests final : public QObject {
    Q_OBJECT

private slots:
    void largeListRemainsResponsive();
    void streamReconnectsAfterDaemonReturns();
    void reconnectBackoffIsBounded();
    void legacyUiPreferencesMigrateOnce();
    void batchImportCarriesAdvancedOptions();
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
        QCOMPARE(settings.uiLanguage(), QStringLiteral("de"));

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
        QCOMPARE(settings.uiLanguage(), QStringLiteral("de"));
        settings.resetToDefaults();
    }

    {
        NativeSettings settings(settingsFile, nullptr);
        QCOMPARE(settings.defaultConnections(), 8);
        QVERIFY(!settings.monitorClipboard());
        QCOMPARE(settings.uiLanguage(), QStringLiteral("system"));
        QVERIFY(settings.defaultSaveDirectory() != QStringLiteral("/changed/legacy"));
    }

    if (previousDataDir.isEmpty()) {
        qunsetenv("NOVA_NATIVE_DATA_DIR");
    } else {
        qputenv("NOVA_NATIVE_DATA_DIR", previousDataDir);
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
                socket->write(
                    "HTTP/1.1 200 OK\r\n"
                    "Content-Type: application/json\r\n"
                    "Content-Length: 15\r\n"
                    "Connection: close\r\n"
                    "\r\n"
                    "{\"id\":\"task-1\"}"
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

    const QVariantMap advanced{
        {QStringLiteral("referer"), QStringLiteral("https://origin.test/page")},
        {QStringLiteral("userAgent"), QStringLiteral("NOVA-Test-Agent")},
        {QStringLiteral("retryCount"), 7},
        {QStringLiteral("timeoutSec"), 45}
    };
    const QVariantMap options{
        {QStringLiteral("queueId"), QStringLiteral("night")},
        {QStringLiteral("advanced"), advanced}
    };

    client.importBatch(
        QStringLiteral("https://example.test/file.zip"),
        QString(),
        8,
        false,
        options
    );

    QTRY_VERIFY_WITH_TIMEOUT(!capturedBody.isEmpty(), 3000);

    const QJsonDocument request = QJsonDocument::fromJson(capturedBody);
    QVERIFY(request.isObject());
    const QJsonObject body = request.object();
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
    QCOMPARE(direct.value(QStringLiteral("retryCount")).toInt(), 7);
    QCOMPARE(direct.value(QStringLiteral("timeoutSec")).toInt(), 45);
    QVERIFY(direct.value(QStringLiteral("segmented")).toBool());
}

QTEST_GUILESS_MAIN(NativeParityTests)
#include "NativeParityTests.moc"
