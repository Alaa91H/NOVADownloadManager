#pragma once

#include <QObject>
#include <QString>

class QClipboard;
class QTimer;

class ClipboardMonitor final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool enabled READ enabled WRITE setEnabled NOTIFY enabledChanged)

public:
    explicit ClipboardMonitor(QObject *parent = nullptr);

    bool enabled() const noexcept { return m_enabled; }
    void setEnabled(bool enabled);

    Q_INVOKABLE void acknowledge(const QString &sourceText);

signals:
    void enabledChanged();
    void urlDetected(const QString &url, const QString &sourceText);

private:
    void poll();
    static QString extractFirstHttpUrl(const QString &text);

    QClipboard *m_clipboard{nullptr};
    QTimer *m_timer{nullptr};
    bool m_enabled{false};
    bool m_primed{false};
    QString m_lastAcceptedText;
};
