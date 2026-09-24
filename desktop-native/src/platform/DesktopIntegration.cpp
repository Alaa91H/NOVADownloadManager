#include "platform/DesktopIntegration.h"

#include <QDesktopServices>
#include <QDir>
#include <QFileInfo>
#include <QProcess>
#include <QUrl>

DesktopIntegration::DesktopIntegration(QObject *parent)
    : QObject(parent) {}

void DesktopIntegration::fail(const QString &action, const QString &message) {
    emit operationFailed(action, message);
}

bool DesktopIntegration::openLocalUrl(const QString &action, const QString &path) {
    const bool opened = QDesktopServices::openUrl(QUrl::fromLocalFile(path));
    if (!opened) {
        fail(action, QStringLiteral("The operating system could not open this location."));
        return false;
    }

    emit operationSucceeded(action);
    return true;
}

bool DesktopIntegration::openFile(const QString &path) {
    const QString trimmedPath = path.trimmed();
    if (trimmedPath.isEmpty()) {
        fail(QStringLiteral("open-file"), QStringLiteral("This download has no destination path."));
        return false;
    }

    const QFileInfo fileInfo(trimmedPath);
    if (!fileInfo.exists() || !fileInfo.isFile()) {
        fail(QStringLiteral("open-file"), QStringLiteral("The downloaded file does not exist yet."));
        return false;
    }

    return openLocalUrl(QStringLiteral("open-file"), fileInfo.absoluteFilePath());
}

bool DesktopIntegration::openFolder(const QString &path) {
    const QString trimmedPath = path.trimmed();
    if (trimmedPath.isEmpty()) {
        fail(QStringLiteral("open-folder"), QStringLiteral("This download has no destination path."));
        return false;
    }

    const QFileInfo pathInfo(trimmedPath);
    const QString folderPath = pathInfo.isDir()
        ? pathInfo.absoluteFilePath()
        : pathInfo.absolutePath();

    if (folderPath.isEmpty() || !QDir(folderPath).exists()) {
        fail(QStringLiteral("open-folder"), QStringLiteral("The destination folder does not exist."));
        return false;
    }

    return openLocalUrl(QStringLiteral("open-folder"), folderPath);
}

bool DesktopIntegration::revealInFolder(const QString &path) {
    const QString trimmedPath = path.trimmed();
    if (trimmedPath.isEmpty()) {
        fail(QStringLiteral("reveal-file"), QStringLiteral("This download has no destination path."));
        return false;
    }

    const QFileInfo fileInfo(trimmedPath);
    if (!fileInfo.exists() || !fileInfo.isFile()) {
        return openFolder(trimmedPath);
    }

#if defined(Q_OS_WIN)
    const QString nativePath = QDir::toNativeSeparators(fileInfo.absoluteFilePath());
    const bool started = QProcess::startDetached(
        QStringLiteral("explorer.exe"),
        {QStringLiteral("/select,%1").arg(nativePath)}
    );
#elif defined(Q_OS_MACOS)
    const bool started = QProcess::startDetached(
        QStringLiteral("/usr/bin/open"),
        {QStringLiteral("-R"), fileInfo.absoluteFilePath()}
    );
#else
    return openFolder(fileInfo.absoluteFilePath());
#endif

    if (!started) {
        fail(QStringLiteral("reveal-file"), QStringLiteral("The operating system could not reveal this file."));
        return false;
    }

    emit operationSucceeded(QStringLiteral("reveal-file"));
    return true;
}
