#include "platform/DesktopIntegration.h"

#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QSet>
#include <QUrl>
#include <QVariantMap>
#include <QVector>
#include <QWindow>

#if defined(Q_OS_WIN)
#include <windows.h>
#include <shobjidl.h>
#endif

#if defined(Q_OS_LINUX)
#include <QDBusConnection>
#include <QDBusMessage>
#endif


namespace {

QVariantMap inspectNativeHostManifest(const QString &path) {
    QVariantMap result;
    result.insert(QStringLiteral("path"), path);

    const QFileInfo info(path);
    const bool manifestExists = info.exists() && info.isFile();
    result.insert(QStringLiteral("manifestExists"), manifestExists);
    if (!manifestExists) {
        result.insert(QStringLiteral("valid"), false);
        result.insert(QStringLiteral("hostExecutableExists"), false);
        return result;
    }

    QFile file(info.absoluteFilePath());
    if (!file.open(QIODevice::ReadOnly)) {
        result.insert(QStringLiteral("valid"), false);
        result.insert(QStringLiteral("hostExecutableExists"), false);
        return result;
    }

    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) {
        result.insert(QStringLiteral("valid"), false);
        result.insert(QStringLiteral("hostExecutableExists"), false);
        return result;
    }

    const QJsonObject object = document.object();
    const QString name = object.value(QStringLiteral("name")).toString();
    const QString hostPath = object.value(QStringLiteral("path")).toString();
    const QFileInfo hostInfo(hostPath);

    result.insert(QStringLiteral("name"), name);
    result.insert(QStringLiteral("hostExecutable"), hostPath);
    result.insert(
        QStringLiteral("hostExecutableExists"),
        !hostPath.isEmpty() && hostInfo.exists() && hostInfo.isFile()
    );
    result.insert(
        QStringLiteral("valid"),
        name == QStringLiteral("com.nova.downloadmanager")
            && !hostPath.isEmpty()
            && hostInfo.exists()
            && hostInfo.isFile()
    );
    return result;
}

#if defined(Q_OS_WIN)
QString readRegistryString(
    HKEY root,
    const QString &subKey,
    const wchar_t *valueName
) {
    const REGSAM views[] = {
        KEY_READ,
        KEY_READ | KEY_WOW64_64KEY,
        KEY_READ | KEY_WOW64_32KEY
    };

    for (REGSAM access : views) {
        HKEY key = nullptr;
        if (RegOpenKeyExW(
                root,
                reinterpret_cast<LPCWSTR>(subKey.utf16()),
                0,
                access,
                &key
            ) != ERROR_SUCCESS) {
            continue;
        }

        DWORD type = 0;
        DWORD bytes = 0;
        const LONG sizeResult = RegQueryValueExW(
            key,
            valueName,
            nullptr,
            &type,
            nullptr,
            &bytes
        );
        if (sizeResult != ERROR_SUCCESS
            || (type != REG_SZ && type != REG_EXPAND_SZ)
            || bytes < sizeof(wchar_t)) {
            RegCloseKey(key);
            continue;
        }

        QVector<wchar_t> buffer(
            static_cast<qsizetype>(bytes / sizeof(wchar_t)) + 1,
            L'\0'
        );
        DWORD readBytes = bytes;
        const LONG readResult = RegQueryValueExW(
            key,
            valueName,
            nullptr,
            &type,
            reinterpret_cast<LPBYTE>(buffer.data()),
            &readBytes
        );
        RegCloseKey(key);

        if (readResult == ERROR_SUCCESS) {
            QString value = QString::fromWCharArray(buffer.constData()).trimmed();
            if (type == REG_EXPAND_SZ) {
                wchar_t expanded[32768]{};
                const DWORD expandedLength = ExpandEnvironmentStringsW(
                    reinterpret_cast<LPCWSTR>(value.utf16()),
                    expanded,
                    32768
                );
                if (expandedLength > 0 && expandedLength < 32768) {
                    value = QString::fromWCharArray(expanded).trimmed();
                }
            }
            if (!value.isEmpty()) {
                return value;
            }
        }
    }

    return {};
}

QString readBrowserRegistration(const QString &subKey) {
    QString value = readRegistryString(HKEY_CURRENT_USER, subKey, nullptr);
    if (!value.isEmpty()) {
        return value;
    }
    return readRegistryString(HKEY_LOCAL_MACHINE, subKey, nullptr);
}

bool writeUserBrowserRegistration(const QString &subKey, const QString &manifestPath) {
    HKEY key = nullptr;
    DWORD disposition = 0;
    if (RegCreateKeyExW(
            HKEY_CURRENT_USER,
            reinterpret_cast<LPCWSTR>(subKey.utf16()),
            0,
            nullptr,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            nullptr,
            &key,
            &disposition
        ) != ERROR_SUCCESS) {
        return false;
    }

    Q_UNUSED(disposition)
    const std::wstring native = QDir::toNativeSeparators(manifestPath).toStdWString();
    const DWORD bytes = static_cast<DWORD>((native.size() + 1) * sizeof(wchar_t));
    const LONG result = RegSetValueExW(
        key,
        nullptr,
        0,
        REG_SZ,
        reinterpret_cast<const BYTE *>(native.c_str()),
        bytes
    );
    RegCloseKey(key);
    return result == ERROR_SUCCESS;
}

QVariantMap trustedWindowsRepairSource() {
    const QString appKey = QStringLiteral("Software\\NOVA\\Nova Download Manager");
    const QString installDir = readRegistryString(
        HKEY_LOCAL_MACHINE,
        appKey,
        L"InstallLocation"
    );
    const QString manifestPath = readRegistryString(
        HKEY_LOCAL_MACHINE,
        appKey,
        L"NativeMessagingManifest"
    );

    QVariantMap result = inspectNativeHostManifest(manifestPath);
    result.insert(QStringLiteral("installDir"), installDir);

    bool trusted = false;
    if (!installDir.isEmpty() && !manifestPath.isEmpty()) {
        const QString canonicalInstall = QFileInfo(installDir).canonicalFilePath();
        const QString canonicalManifest = QFileInfo(manifestPath).canonicalFilePath();
        const QString canonicalHost = QFileInfo(
            result.value(QStringLiteral("hostExecutable")).toString()
        ).canonicalFilePath();

        const QString installPrefix = QDir::cleanPath(canonicalInstall) + QDir::separator();
        trusted = !canonicalInstall.isEmpty()
            && !canonicalManifest.isEmpty()
            && !canonicalHost.isEmpty()
            && canonicalManifest.startsWith(installPrefix, Qt::CaseInsensitive)
            && canonicalHost.startsWith(installPrefix, Qt::CaseInsensitive)
            && result.value(QStringLiteral("valid")).toBool();
    }
    result.insert(QStringLiteral("trusted"), trusted);
    return result;
}
#endif

} // namespace

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

bool DesktopIntegration::openExternalUrl(const QString &url) {
    const QUrl target = QUrl::fromUserInput(url.trimmed());
    if (!target.isValid() || target.scheme().isEmpty()) {
        fail(QStringLiteral("open-url"), QStringLiteral("The external URL is invalid."));
        return false;
    }

    const QString scheme = target.scheme().toLower();
    if (scheme != QStringLiteral("http") && scheme != QStringLiteral("https")) {
        fail(QStringLiteral("open-url"), QStringLiteral("Only HTTP and HTTPS links can be opened externally."));
        return false;
    }

    const bool opened = QDesktopServices::openUrl(target);
    if (!opened) {
        fail(QStringLiteral("open-url"), QStringLiteral("The operating system could not open this link."));
        return false;
    }

    emit operationSucceeded(QStringLiteral("open-url"));
    return true;
}


QVariantMap DesktopIntegration::browserNativeHostStatus() const {
    QVariantMap result;
    result.insert(QStringLiteral("hostName"), QStringLiteral("com.nova.downloadmanager"));

#if defined(Q_OS_WIN)
    result.insert(QStringLiteral("platform"), QStringLiteral("windows"));
    result.insert(QStringLiteral("supported"), true);

    const QString suffix = QStringLiteral(
        "NativeMessagingHosts\\com.nova.downloadmanager"
    );
    const QString chromeKey = QStringLiteral("Software\\Google\\Chrome\\") + suffix;
    const QString edgeKey = QStringLiteral("Software\\Microsoft\\Edge\\") + suffix;
    const QString firefoxKey = QStringLiteral("Software\\Mozilla\\") + suffix;

    const QString chromePath = readBrowserRegistration(chromeKey);
    const QString edgePath = readBrowserRegistration(edgeKey);
    const QString firefoxPath = readBrowserRegistration(firefoxKey);

    const QVariantMap chrome = inspectNativeHostManifest(chromePath);
    const QVariantMap edge = inspectNativeHostManifest(edgePath);
    const QVariantMap firefox = inspectNativeHostManifest(firefoxPath);

    const bool chromeRegistered = chrome.value(QStringLiteral("valid")).toBool();
    const bool edgeRegistered = edge.value(QStringLiteral("valid")).toBool();
    const bool firefoxRegistered = firefox.value(QStringLiteral("valid")).toBool();

    result.insert(QStringLiteral("chromeRegistered"), chromeRegistered);
    result.insert(QStringLiteral("edgeRegistered"), edgeRegistered);
    result.insert(QStringLiteral("firefoxRegistered"), firefoxRegistered);
    result.insert(
        QStringLiteral("allRegistered"),
        chromeRegistered && edgeRegistered && firefoxRegistered
    );

    const QVariantMap repairSource = trustedWindowsRepairSource();
    result.insert(
        QStringLiteral("manifestPath"),
        repairSource.value(QStringLiteral("path"))
    );
    result.insert(
        QStringLiteral("manifestValid"),
        repairSource.value(QStringLiteral("valid"))
    );
    result.insert(
        QStringLiteral("hostExecutable"),
        repairSource.value(QStringLiteral("hostExecutable"))
    );
    result.insert(
        QStringLiteral("hostExecutableExists"),
        repairSource.value(QStringLiteral("hostExecutableExists"))
    );
    result.insert(
        QStringLiteral("repairAvailable"),
        repairSource.value(QStringLiteral("trusted"))
    );
#elif defined(Q_OS_MACOS)
    result.insert(QStringLiteral("platform"), QStringLiteral("macos"));
    result.insert(QStringLiteral("supported"), true);

    const QString home = QDir::homePath();
    const QString chromePath = QDir(home).filePath(
        QStringLiteral("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.nova.downloadmanager.json")
    );
    const QString edgePath = QDir(home).filePath(
        QStringLiteral("Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.nova.downloadmanager.json")
    );
    const QString firefoxPath = QDir(home).filePath(
        QStringLiteral("Library/Application Support/Mozilla/NativeMessagingHosts/com.nova.downloadmanager.json")
    );

    const bool chromeRegistered = inspectNativeHostManifest(chromePath)
        .value(QStringLiteral("valid")).toBool();
    const bool edgeRegistered = inspectNativeHostManifest(edgePath)
        .value(QStringLiteral("valid")).toBool();
    const bool firefoxRegistered = inspectNativeHostManifest(firefoxPath)
        .value(QStringLiteral("valid")).toBool();

    result.insert(QStringLiteral("chromeRegistered"), chromeRegistered);
    result.insert(QStringLiteral("edgeRegistered"), edgeRegistered);
    result.insert(QStringLiteral("firefoxRegistered"), firefoxRegistered);
    result.insert(
        QStringLiteral("allRegistered"),
        chromeRegistered && edgeRegistered && firefoxRegistered
    );
    result.insert(QStringLiteral("repairAvailable"), false);
#else
    result.insert(QStringLiteral("platform"), QStringLiteral("linux"));
    result.insert(QStringLiteral("supported"), true);

    const QString home = QDir::homePath();
    const QString chromePath = QDir(home).filePath(
        QStringLiteral(".config/google-chrome/NativeMessagingHosts/com.nova.downloadmanager.json")
    );
    const QString chromiumPath = QDir(home).filePath(
        QStringLiteral(".config/chromium/NativeMessagingHosts/com.nova.downloadmanager.json")
    );
    const QString edgePath = QDir(home).filePath(
        QStringLiteral(".config/microsoft-edge/NativeMessagingHosts/com.nova.downloadmanager.json")
    );
    const QString firefoxPath = QDir(home).filePath(
        QStringLiteral(".mozilla/native-messaging-hosts/com.nova.downloadmanager.json")
    );

    const bool chromeRegistered =
        inspectNativeHostManifest(chromePath).value(QStringLiteral("valid")).toBool()
        || inspectNativeHostManifest(chromiumPath).value(QStringLiteral("valid")).toBool();
    const bool edgeRegistered = inspectNativeHostManifest(edgePath)
        .value(QStringLiteral("valid")).toBool();
    const bool firefoxRegistered = inspectNativeHostManifest(firefoxPath)
        .value(QStringLiteral("valid")).toBool();

    result.insert(QStringLiteral("chromeRegistered"), chromeRegistered);
    result.insert(QStringLiteral("edgeRegistered"), edgeRegistered);
    result.insert(QStringLiteral("firefoxRegistered"), firefoxRegistered);
    result.insert(
        QStringLiteral("allRegistered"),
        chromeRegistered && edgeRegistered && firefoxRegistered
    );
    result.insert(QStringLiteral("repairAvailable"), false);
#endif

    return result;
}

bool DesktopIntegration::repairBrowserNativeHost() {
#if defined(Q_OS_WIN)
    const QVariantMap source = trustedWindowsRepairSource();
    if (!source.value(QStringLiteral("trusted")).toBool()) {
        fail(
            QStringLiteral("browser-host-repair"),
            QStringLiteral("A trusted installed NOVA native-host manifest was not found.")
        );
        return false;
    }

    const QString manifestPath = source.value(QStringLiteral("path")).toString();
    const QString suffix = QStringLiteral(
        "NativeMessagingHosts\\com.nova.downloadmanager"
    );

    const bool chrome = writeUserBrowserRegistration(
        QStringLiteral("Software\\Google\\Chrome\\") + suffix,
        manifestPath
    );
    const bool edge = writeUserBrowserRegistration(
        QStringLiteral("Software\\Microsoft\\Edge\\") + suffix,
        manifestPath
    );
    const bool firefox = writeUserBrowserRegistration(
        QStringLiteral("Software\\Mozilla\\") + suffix,
        manifestPath
    );

    if (!(chrome && edge && firefox)) {
        fail(
            QStringLiteral("browser-host-repair"),
            QStringLiteral("NOVA could not repair every browser native-host registration.")
        );
        return false;
    }

    emit operationSucceeded(QStringLiteral("browser-host-repair"));
    return true;
#else
    fail(
        QStringLiteral("browser-host-repair"),
        QStringLiteral("Automatic native-host repair is not available on this platform yet.")
    );
    return false;
#endif
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
