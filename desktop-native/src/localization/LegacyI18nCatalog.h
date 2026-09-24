#pragma once

#include <QHash>
#include <QMultiHash>
#include <QSet>
#include <QString>
#include <QVariantList>

class LegacyI18nCatalog final {
public:
    static const LegacyI18nCatalog &instance();

    QVariantList supportedLanguages() const;
    QString normalizeLanguage(const QString &language) const;
    bool rtl(const QString &language) const;
    QString translate(
        const QString &language,
        const QString &nativeKey,
        const QString &englishValue
    ) const;

private:
    LegacyI18nCatalog();

    static QHash<QString, QString> parseLocaleResource(const QString &resourcePath);
    static QString decodeJsString(const QString &value);
    static QString legacyKeyCandidate(const QString &nativeKey);

    const QHash<QString, QString> &locale(const QString &language) const;

    QHash<QString, QString> m_resourceFileByCode;
    QSet<QString> m_rtlLanguages;
    QVariantList m_supportedLanguages;
    QMultiHash<QString, QString> m_legacyKeysByEnglish;
    mutable QHash<QString, QHash<QString, QString>> m_localeCache;
};
