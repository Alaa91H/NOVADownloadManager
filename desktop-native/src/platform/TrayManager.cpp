#include "platform/TrayManager.h"

#include <QAction>
#include <QApplication>
#include <QIcon>
#include <QJsonObject>
#include <QMenu>
#include <QPainter>
#include <QPixmap>

namespace {
QIcon novaTrayIcon() {
    QIcon icon = QIcon::fromTheme(QStringLiteral("folder-download"));
    if (!icon.isNull()) {
        return icon;
    }

    QPixmap pixmap(32, 32);
    pixmap.fill(Qt::transparent);
    QPainter painter(&pixmap);
    painter.setRenderHint(QPainter::Antialiasing, true);
    painter.setBrush(QColor(QStringLiteral("#4f8cff")));
    painter.setPen(Qt::NoPen);
    painter.drawRoundedRect(QRectF(1, 1, 30, 30), 7, 7);
    painter.setPen(Qt::white);
    QFont font = painter.font();
    font.setBold(true);
    font.setPixelSize(18);
    painter.setFont(font);
    painter.drawText(pixmap.rect(), Qt::AlignCenter, QStringLiteral("N"));
    return QIcon(pixmap);
}
}

TrayManager::TrayManager(QObject *parent)
    : QObject(parent) {
    m_tray = new QSystemTrayIcon(novaTrayIcon(), this);
    m_tray->setToolTip(QStringLiteral("NOVA Download Manager"));

    m_menu = new QMenu();
    auto *showAction = m_menu->addAction(QStringLiteral("Show NOVA"));
    m_menu->addSeparator();
    auto *quitAction = m_menu->addAction(QStringLiteral("Quit"));

    connect(showAction, &QAction::triggered, this, &TrayManager::showRequested);
    connect(quitAction, &QAction::triggered, this, &TrayManager::quitRequested);
    connect(m_tray, &QSystemTrayIcon::activated, this, [this](QSystemTrayIcon::ActivationReason reason) {
        if (reason == QSystemTrayIcon::Trigger || reason == QSystemTrayIcon::DoubleClick) {
            emit showRequested();
        }
    });

    m_tray->setContextMenu(m_menu);
}

TrayManager::~TrayManager() {
    if (m_tray) {
        m_tray->hide();
    }
    delete m_menu;
}

bool TrayManager::available() const noexcept {
    return QSystemTrayIcon::isSystemTrayAvailable();
}

void TrayManager::setEnabled(bool enabled) {
    const bool next = enabled && available();
    if (m_enabled == next) {
        return;
    }

    m_enabled = next;
    if (m_enabled) {
        m_tray->show();
    } else {
        m_tray->hide();
    }
    emit enabledChanged();
}

void TrayManager::showNotification(const QString &title, const QString &message) {
    if (!m_enabled || !m_notificationsEnabled || title.trimmed().isEmpty()) {
        return;
    }

    m_tray->showMessage(
        title,
        message,
        QSystemTrayIcon::Information,
        6000
    );
}

void TrayManager::handleDownloads(const QJsonArray &downloads) {
    QHash<QString, QString> nextStatuses;

    for (const QJsonValue &value : downloads) {
        const QJsonObject object = value.toObject();
        const QString id = object.value(QStringLiteral("id")).toString();
        const QString status = object.value(QStringLiteral("status")).toString().toLower();
        if (id.isEmpty()) {
            continue;
        }

        nextStatuses.insert(id, status);
        if (!m_initializedStatuses) {
            continue;
        }

        const QString previous = m_statusByTask.value(id);
        if (previous == status) {
            continue;
        }

        const QString name = object.value(QStringLiteral("name")).toString(QStringLiteral("Download"));
        if (status == QStringLiteral("completed") && m_notifyOnComplete) {
            showNotification(
                QStringLiteral("Download completed"),
                name
            );
        } else if ((status == QStringLiteral("failed")
                    || status == QStringLiteral("error")
                    || status == QStringLiteral("interrupted"))
                   && m_notifyOnFailure) {
            const QString detail = object.value(QStringLiteral("errorMessage")).toString();
            showNotification(
                QStringLiteral("Download failed"),
                detail.isEmpty() ? name : QStringLiteral("%1\n%2").arg(name, detail)
            );
        }
    }

    m_statusByTask = nextStatuses;
    m_initializedStatuses = true;
}
