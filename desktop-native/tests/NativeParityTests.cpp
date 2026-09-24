#include <QtTest>

#include <QElapsedTimer>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonObject>
#include <QSignalSpy>
#include <QTcpServer>
#include <QTcpSocket>

#include "api/NovaApiClient.h"
#include "models/DownloadListModel.h"

class NativeParityTests final : public QObject {
    Q_OBJECT

private slots:
    void largeListRemainsResponsive();
    void streamReconnectsAfterDaemonReturns();
    void reconnectBackoffIsBounded();
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
        item.insert(QStringLiteral("savePath"), QStringLiteral("/tmp/NOVA/download-%1.bin").arg(i));
        item.insert(QStringLiteral("engine"), QStringLiteral("native"));
        item.insert(QStringLiteral("category"), QStringLiteral("binary"));
        item.insert(QStringLiteral("connections"), 8);
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

    QCOMPARE(model.totalCount(), itemCount);
    QCOMPARE(model.count(), itemCount);
    QCOMPARE(model.activeCount(), itemCount / 4);
    QVERIFY2(
        initialLoadMs < 8000,
        qPrintable(QStringLiteral("20k model load took %1 ms").arg(initialLoadMs))
    );

    timer.restart();
    model.setFilterState(QStringLiteral("active"));
    QCOMPARE(model.count(), itemCount / 4);
    QVERIFY2(
        timer.elapsed() < 3000,
        "Filtering 20k downloads exceeded the native UI stress budget"
    );

    timer.restart();
    model.setSortKey(QStringLiteral("speed"));
    model.setSortAscending(false);
    QVERIFY2(
        timer.elapsed() < 3000,
        "Sorting the active large-list view exceeded the native UI stress budget"
    );

    timer.restart();
    model.setFilterState(QStringLiteral("downloads"));
    model.setSearchQuery(QStringLiteral("download-19999.bin"));
    QCOMPARE(model.count(), 1);
    QCOMPARE(model.itemAt(0).value(QStringLiteral("taskId")).toString(), QStringLiteral("task-019999"));
    QVERIFY2(
        timer.elapsed() < 3000,
        "Searching 20k downloads exceeded the native UI stress budget"
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

QTEST_GUILESS_MAIN(NativeParityTests)
#include "NativeParityTests.moc"
