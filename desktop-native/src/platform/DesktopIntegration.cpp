#include "platform/DesktopIntegration.h"

#include <QDesktopServices>
#include <QDir>
#include <QFileDialog>
#include <QFileInfo>
#include <QJsonObject>
#include <QProcess>
#include <QUrl>
#include <QVariantMap>
#include <QWindow>

#if defined(Q_OS_WIN)
#include <windows.h>
#include <shobjidl.h>
#endif

#if defined(Q_OS_LINUX)
#include <QDBusConnection>
#include <QDBusMessage>
#endif

DesktopIntegration::DesktopIntegration(QObject *parent)
    : QObject(parent) {
#if defined(Q_OS_WIN)
    const HRESULT initResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    m_comInitialized = SUCCEEDED(initResult);

    ITaskbarList3 *taskbar = nullptr;
    if (SUCCEEDED(CoCreateInstance(
            CLSID_TaskbarList,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&taskbar)))) {
        if (SUCCEEDED(taskbar->HrInit())) {
            m_taskbar = taskbar;
        } else {
            taskbar->Release();
        }
    }
#endif
}

DesktopIntegration::~DesktopIntegration() {
#if defined(Q_OS_WIN)
    if (m_taskbar) {
        static_cast<ITaskbarList3 *>(m_taskbar)->Release();
        m_taskbar = nullptr;
    }
    if (m_comInitialized) {
        CoUninitialize();
    }
#endif
}

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

#if defined(Q_OS_WIN) || defined(Q_OS_MACOS)
    if (!started) {
        fail(QStringLiteral("reveal-file"), QStringLiteral("The operating system could not reveal this file."));
        return false;
    }

    emit operationSucceeded(QStringLiteral("reveal-file"));
    return true;
#endif
}


QString DesktopIntegration::chooseDirectory(const QString &initialDirectory) {
    QString initial = initialDirectory.trimmed();
    if (initial.isEmpty() || !QDir(initial).exists()) {
        initial = QDir::homePath();
    }

    return QFileDialog::getExistingDirectory(
        nullptr,
        QStringLiteral("Choose download folder"),
        initial,
        QFileDialog::ShowDirsOnly | QFileDialog::DontResolveSymlinks
    );
}

QString DesktopIntegration::chooseSaveFile(
    const QString &suggestedPath,
    const QString &filter
) {
    QString initial = suggestedPath.trimmed();
    if (initial.isEmpty()) {
        initial = QDir::home().filePath(QStringLiteral("download"));
    }

    return QFileDialog::getSaveFileName(
        nullptr,
        QStringLiteral("Choose download destination"),
        initial,
        filter.trimmed().isEmpty() ? QStringLiteral("All files (*)") : filter
    );
}

void DesktopIntegration::setWindow(QWindow *window) {
    m_window = window;
}

void DesktopIntegration::handleDownloads(const QJsonArray &downloads) {
    int activeCount = 0;
    qint64 totalKnownBytes = 0;
    qint64 totalDownloadedBytes = 0;
    qreal progressAccumulator = 0.0;
    int progressSamples = 0;

    for (const QJsonValue &value : downloads) {
        const QJsonObject object = value.toObject();
        const QString status = object.value(QStringLiteral("status")).toString().trimmed().toLower();
        const bool active =
            status == QStringLiteral("downloading")
            || status == QStringLiteral("preparing")
            || status == QStringLiteral("probing")
            || status == QStringLiteral("retrying")
            || status == QStringLiteral("recovering")
            || status == QStringLiteral("verifying")
            || status == QStringLiteral("finalizing");

        if (!active) {
            continue;
        }

        ++activeCount;
        const qint64 size = object.value(QStringLiteral("sizeBytes")).toInteger();
        const qint64 downloaded = object.value(QStringLiteral("downloadedBytes")).toInteger();
        if (size > 0) {
            totalKnownBytes += size;
            totalDownloadedBytes += qBound<qint64>(0, downloaded, size);
        }

        const qreal progress = object.value(QStringLiteral("progress")).toDouble(-1.0);
        if (progress >= 0.0) {
            progressAccumulator += qBound<qreal>(0.0, progress, 1.0);
            ++progressSamples;
        }
    }

    if (activeCount == 0) {
        setDesktopProgress(false, false, 0.0, 0);
        return;
    }

    if (totalKnownBytes > 0) {
        setDesktopProgress(
            true,
            false,
            qBound<qreal>(
                0.0,
                static_cast<qreal>(totalDownloadedBytes) / static_cast<qreal>(totalKnownBytes),
                1.0
            ),
            activeCount
        );
        return;
    }

    if (progressSamples > 0) {
        setDesktopProgress(
            true,
            false,
            qBound<qreal>(
                0.0,
                progressAccumulator / static_cast<qreal>(progressSamples),
                1.0
            ),
            activeCount
        );
        return;
    }

    setDesktopProgress(true, true, 0.0, activeCount);
}

void DesktopIntegration::setDesktopProgress(
    bool visible,
    bool indeterminate,
    qreal progress,
    int activeCount
) {
#if defined(Q_OS_WIN)
    if (m_window && m_taskbar) {
        auto *taskbar = static_cast<ITaskbarList3 *>(m_taskbar);
        const HWND hwnd = reinterpret_cast<HWND>(m_window->winId());

        if (!visible) {
            taskbar->SetProgressState(hwnd, TBPF_NOPROGRESS);
        } else if (indeterminate) {
            taskbar->SetProgressState(hwnd, TBPF_INDETERMINATE);
        } else {
            taskbar->SetProgressState(hwnd, TBPF_NORMAL);
            const ULONGLONG completed = static_cast<ULONGLONG>(
                qBound<qreal>(0.0, progress, 1.0) * 1000.0
            );
            taskbar->SetProgressValue(hwnd, completed, 1000);
        }
    }
#elif defined(Q_OS_LINUX)
    QVariantMap properties;
    properties.insert(QStringLiteral("progress-visible"), visible);
    properties.insert(QStringLiteral("progress"), qBound<qreal>(0.0, progress, 1.0));
    properties.insert(QStringLiteral("count-visible"), visible && activeCount > 0);
    properties.insert(QStringLiteral("count"), activeCount);

    QDBusMessage message = QDBusMessage::createSignal(
        QStringLiteral("/com/canonical/Unity/LauncherEntry"),
        QStringLiteral("com.canonical.Unity.LauncherEntry"),
        QStringLiteral("Update")
    );
    message << QStringLiteral("application://nova-native.desktop") << properties;
    QDBusConnection::sessionBus().send(message);
#else
    Q_UNUSED(visible)
    Q_UNUSED(indeterminate)
    Q_UNUSED(progress)
    Q_UNUSED(activeCount)
#endif
}
