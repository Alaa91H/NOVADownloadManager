#include <QtTest>

#include <cmath>

#include <QGuiApplication>
#include <QScreen>
#include <QWindow>

class DisplayScaleTests final : public QObject {
    Q_OBJECT

private slots:
    void windowHonorsRequestedScaleFactor();
    void allScreensExposeValidMetrics();
    void windowCanSwitchScreensWhenAvailable();
};

void DisplayScaleTests::windowHonorsRequestedScaleFactor() {
    bool ok = false;
    const qreal expected = qEnvironmentVariable("NOVA_EXPECT_SCALE_FACTOR").toDouble(&ok);
    QVERIFY2(ok && expected > 0.0, "NOVA_EXPECT_SCALE_FACTOR must be a positive number");

    QWindow window;
    window.resize(800, 600);
    window.show();
    QCoreApplication::processEvents();

    const qreal dpr = window.devicePixelRatio();
    QVERIFY2(std::isfinite(dpr), "Window device pixel ratio must be finite");
    QVERIFY2(dpr > 0.0, "Window device pixel ratio must be positive");
    QVERIFY2(
        dpr + 0.01 >= expected,
        qPrintable(
            QStringLiteral("Expected window DPR >= %1 under QT_SCALE_FACTOR, got %2")
                .arg(expected, 0, 'f', 2)
                .arg(dpr, 0, 'f', 2)
        )
    );

    const QSize logicalSize = window.size();
    QCOMPARE(logicalSize, QSize(800, 600));
}

void DisplayScaleTests::allScreensExposeValidMetrics() {
    const QList<QScreen *> screens = QGuiApplication::screens();
    QVERIFY2(!screens.isEmpty(), "Qt must expose at least one screen");

    for (QScreen *screen : screens) {
        QVERIFY(screen != nullptr);
        QVERIFY2(screen->devicePixelRatio() > 0.0, "Screen DPR must be positive");
        QVERIFY2(screen->logicalDotsPerInch() > 0.0, "Logical DPI must be positive");
        QVERIFY2(screen->geometry().isValid(), "Screen geometry must be valid");
        QVERIFY2(
            screen->availableGeometry().isValid(),
            "Available screen geometry must be valid"
        );
    }
}

void DisplayScaleTests::windowCanSwitchScreensWhenAvailable() {
    const QList<QScreen *> screens = QGuiApplication::screens();
    if (screens.size() < 2) {
        QSKIP("Multi-monitor assignment requires at least two screens on this runner");
    }

    QWindow window;
    window.setScreen(screens.first());
    QCOMPARE(window.screen(), screens.first());

    window.setScreen(screens.last());
    QCOMPARE(window.screen(), screens.last());
    QVERIFY(window.devicePixelRatio() > 0.0);
}

QTEST_MAIN(DisplayScaleTests)
#include "DisplayScaleTests.moc"
