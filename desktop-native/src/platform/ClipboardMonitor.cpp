#include "platform/ClipboardMonitor.h"

#include <QClipboard>
#include <QGuiApplication>
#include <QRegularExpression>
#include <QTimer>

ClipboardMonitor::ClipboardMonitor(QObject *parent)
    : QObject(parent),
      m_clipboard(QGuiApplication::clipboard()),
      m_timer(new QTimer(this)) {
    m_timer->setInterval(1500);
    m_timer->setTimerType(Qt::CoarseTimer);

    connect(m_timer, &QTimer::timeout, this, &ClipboardMonitor::poll);
}

void ClipboardMonitor::setEnabled(bool enabled) {
    if (m_enabled == enabled) {
        return;
    }

    m_enabled = enabled;
    m_primed = false;
    m_lastAcceptedText.clear();

    if (m_enabled) {
        m_timer->start();
        poll();
    } else {
        m_timer->stop();
    }

    emit enabledChanged();
}

void ClipboardMonitor::acknowledge(const QString &sourceText) {
    const QString normalized = sourceText.trimmed();
    if (!normalized.isEmpty()) {
        m_lastAcceptedText = normalized;
    }
}

QString ClipboardMonitor::extractFirstHttpUrl(const QString &text) {
    static const QRegularExpression expression(
        QStringLiteral(R"(https?://[^\s<>"'\x60]+)"),
        QRegularExpression::CaseInsensitiveOption
    );

    const QRegularExpressionMatch match = expression.match(text);
    if (!match.hasMatch()) {
        return {};
    }

    QString url = match.captured(0);
    while (!url.isEmpty()) {
        const QChar last = url.back();
        if (last == QLatin1Char(')')
            || last == QLatin1Char(',')
            || last == QLatin1Char('.')
            || last == QLatin1Char(';')
            || last == QLatin1Char(']')) {
            url.chop(1);
        } else {
            break;
        }
    }
    return url;
}

void ClipboardMonitor::poll() {
    if (!m_enabled || !m_clipboard) {
        return;
    }

    const QString text = m_clipboard->text(QClipboard::Clipboard).trimmed();

    if (!m_primed) {
        m_lastAcceptedText = text;
        m_primed = true;
        return;
    }

    if (text.isEmpty() || text == m_lastAcceptedText) {
        return;
    }

    const QString url = extractFirstHttpUrl(text);
    if (!url.isEmpty()) {
        emit urlDetected(url, text);
    }
}
