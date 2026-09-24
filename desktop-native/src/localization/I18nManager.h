#pragma once

#include <QObject>
#include <QString>
#include <QVariantList>

class I18nManager final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString language READ language WRITE setLanguage NOTIFY languageChanged)
    Q_PROPERTY(bool rtl READ rtl NOTIFY languageChanged)
    Q_PROPERTY(QVariantList supportedLanguages READ supportedLanguages CONSTANT)

public:
    explicit I18nManager(QObject *parent = nullptr);

    QString language() const { return m_language; }
    bool rtl() const noexcept { return m_language == QStringLiteral("ar"); }
    QVariantList supportedLanguages() const;

    Q_INVOKABLE QString translate(const QString &key) const;
    Q_INVOKABLE void setLanguage(const QString &language);

signals:
    void languageChanged();

private:
    static QString normalizeLanguage(const QString &language);

    QString m_language{QStringLiteral("en")};
};
