#pragma once

#include <QJsonArray>
#include <QObject>
#include <QString>
#include <QVariantMap>

class QWindow;

class DesktopIntegration final : public QObject {
    Q_OBJECT

public:
    explicit DesktopIntegration(QObject *parent = nullptr);
    ~DesktopIntegration() override;

    Q_INVOKABLE bool openFile(const QString &path);
    Q_INVOKABLE bool openFolder(const QString &path);
    Q_INVOKABLE bool revealInFolder(const QString &path);
    Q_INVOKABLE bool openExternalUrl(const QString &url);
    Q_INVOKABLE QVariantMap browserNativeHostStatus() const;
    Q_INVOKABLE bool repairBrowserNativeHost();
    Q_INVOKABLE QString readClipboardText() const;
    Q_INVOKABLE QString chooseDirectory(const QString &initialDirectory = QString());
    Q_INVOKABLE QString chooseSaveFile(
        const QString &suggestedPath = QString(),
        const QString &filter = QStringLiteral("All files (*)")
    );

    void setWindow(QWindow *window);
    void handleDownloads(const QJsonArray &downloads);

signals:
    void operationSucceeded(const QString &action);
    void operationFailed(const QString &action, const QString &message);

private:
    bool openLocalUrl(const QString &action, const QString &path);
    void fail(const QString &action, const QString &message);
    void setDesktopProgress(bool visible, bool indeterminate, qreal progress, int activeCount);

    QWindow *m_window{nullptr};
#if defined(Q_OS_WIN)
    void *m_taskbar{nullptr};
    bool m_comInitialized{false};
#endif
};
