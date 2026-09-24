#pragma once

#include <QObject>
#include <QString>

class DesktopIntegration final : public QObject {
    Q_OBJECT

public:
    explicit DesktopIntegration(QObject *parent = nullptr);

    Q_INVOKABLE bool openFile(const QString &path);
    Q_INVOKABLE bool openFolder(const QString &path);
    Q_INVOKABLE bool revealInFolder(const QString &path);

signals:
    void operationSucceeded(const QString &action);
    void operationFailed(const QString &action, const QString &message);

private:
    bool openLocalUrl(const QString &action, const QString &path);
    void fail(const QString &action, const QString &message);
};
