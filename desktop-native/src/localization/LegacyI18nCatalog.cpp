#include "localization/LegacyI18nCatalog.h"

#include <QFile>
#include <QLocale>
#include <QRegularExpression>
#include <QVariantMap>

namespace {
QString resourceCodeForLegacyLanguage(QString code) {
    code.replace(QLatin1Char('-'), QLatin1Char('_'));
    return code;
}

void appendLanguage(
    QHash<QString, QString> &resourceFileByCode,
    QSet<QString> &rtlLanguages,
    QVariantList &supportedLanguages,
    const QString &rawCode,
    const QString &label,
    bool rtl
) {
    const QString code = rawCode.trimmed().toLower();
    if (code.isEmpty() || resourceFileByCode.contains(code)) {
        return;
    }

    resourceFileByCode.insert(
        code,
        QStringLiteral(":/legacy-i18n/%1.ts").arg(resourceCodeForLegacyLanguage(rawCode))
    );
    if (rtl) {
        rtlLanguages.insert(code);
    }
    supportedLanguages.append(
        QVariantMap{
            {QStringLiteral("code"), code},
            {QStringLiteral("label"), label}
        }
    );
}
}

const LegacyI18nCatalog &LegacyI18nCatalog::instance() {
    static const LegacyI18nCatalog catalog;
    return catalog;
}

LegacyI18nCatalog::LegacyI18nCatalog() {
    m_supportedLanguages.append(
        QVariantMap{
            {QStringLiteral("code"), QStringLiteral("system")},
            {QStringLiteral("label"), QStringLiteral("System")}
        }
    );

    QFile metadata(QStringLiteral(":/legacy-i18n/languageMetadata.ts"));
    if (metadata.open(QIODevice::ReadOnly | QIODevice::Text)) {
        const QString source = QString::fromUtf8(metadata.readAll());
        const QRegularExpression pattern(
            QStringLiteral(
                R"(value:\s*'([^']+)'\s+as\s+Language,\s*label:\s*'([^']+)'[^\n]*direction:\s*'(ltr|rtl)')"
            )
        );

        auto matches = pattern.globalMatch(source);
        while (matches.hasNext()) {
            const auto match = matches.next();
            appendLanguage(
                m_resourceFileByCode,
                m_rtlLanguages,
                m_supportedLanguages,
                match.captured(1),
                match.captured(2),
                match.captured(3) == QStringLiteral("rtl")
            );
        }
    }

    if (!m_resourceFileByCode.contains(QStringLiteral("en"))) {
        appendLanguage(m_resourceFileByCode, m_rtlLanguages, m_supportedLanguages,
                       QStringLiteral("en"), QStringLiteral("English"), false);
    }
    if (!m_resourceFileByCode.contains(QStringLiteral("ar"))) {
        appendLanguage(m_resourceFileByCode, m_rtlLanguages, m_supportedLanguages,
                       QStringLiteral("ar"), QStringLiteral("Arabic"), true);
    }
    if (!m_resourceFileByCode.contains(QStringLiteral("de"))) {
        appendLanguage(m_resourceFileByCode, m_rtlLanguages, m_supportedLanguages,
                       QStringLiteral("de"), QStringLiteral("German"), false);
    }

    const auto englishCatalog = parseLocaleResource(
        m_resourceFileByCode.value(QStringLiteral("en"))
    );
    m_localeCache.insert(QStringLiteral("en"), englishCatalog);
    for (auto it = englishCatalog.constBegin(); it != englishCatalog.constEnd(); ++it) {
        if (!it.value().isEmpty()) {
            m_legacyKeysByEnglish.insert(it.value(), it.key());
        }
    }
}

QVariantList LegacyI18nCatalog::supportedLanguages() const {
    return m_supportedLanguages;
}

QString LegacyI18nCatalog::normalizeLanguage(const QString &language) const {
    QString normalized = language.trimmed();
    if (normalized.isEmpty()
        || normalized.compare(QStringLiteral("system"), Qt::CaseInsensitive) == 0) {
        normalized = QLocale::system().name();
    }

    normalized.replace(QLatin1Char('_'), QLatin1Char('-'));
    normalized = normalized.toLower();

    if (m_resourceFileByCode.contains(normalized)) {
        return normalized;
    }

    const QString primary = normalized.section(QLatin1Char('-'), 0, 0);
    if (m_resourceFileByCode.contains(primary)) {
        return primary;
    }

    return QStringLiteral("en");
}

bool LegacyI18nCatalog::rtl(const QString &language) const {
    return m_rtlLanguages.contains(normalizeLanguage(language));
}

QString LegacyI18nCatalog::translate(
    const QString &language,
    const QString &nativeKey,
    const QString &englishValue
) const {
    const QString normalized = normalizeLanguage(language);
    if (normalized == QStringLiteral("en")) {
        return {};
    }

    const auto &dictionary = locale(normalized);
    if (dictionary.isEmpty()) {
        return {};
    }

    const QString directKey = legacyKeyCandidate(nativeKey);
    const auto direct = dictionary.constFind(directKey);
    if (direct != dictionary.constEnd() && !direct.value().isEmpty()) {
        return direct.value();
    }

    const QList<QString> legacyKeys = m_legacyKeysByEnglish.values(englishValue);
    for (const QString &legacyKey : legacyKeys) {
        const auto translated = dictionary.constFind(legacyKey);
        if (translated != dictionary.constEnd() && !translated.value().isEmpty()) {
            return translated.value();
        }
    }

    return {};
}

const QHash<QString, QString> &LegacyI18nCatalog::locale(const QString &language) const {
    const QString normalized = normalizeLanguage(language);
    auto existing = m_localeCache.constFind(normalized);
    if (existing != m_localeCache.constEnd()) {
        return existing.value();
    }

    const QString resourcePath = m_resourceFileByCode.value(normalized);
    m_localeCache.insert(normalized, parseLocaleResource(resourcePath));
    return m_localeCache.constFind(normalized).value();
}

QHash<QString, QString> LegacyI18nCatalog::parseLocaleResource(const QString &resourcePath) {
    QHash<QString, QString> values;
    if (resourcePath.isEmpty()) {
        return values;
    }

    QFile file(resourcePath);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        return values;
    }

    const QString source = QString::fromUtf8(file.readAll());
    const QRegularExpression entryPattern(
        QStringLiteral(
            R"((?m)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\x60(?:\\.|[^\x60\\])*\x60)\s*,)"
        )
    );

    auto matches = entryPattern.globalMatch(source);
    while (matches.hasNext()) {
        const auto match = matches.next();
        const QString token = match.captured(2);
        if (token.size() < 2) {
            continue;
        }

        values.insert(
            match.captured(1),
            decodeJsString(token.mid(1, token.size() - 2))
        );
    }

    return values;
}

QString LegacyI18nCatalog::decodeJsString(const QString &value) {
    QString decoded;
    decoded.reserve(value.size());

    for (qsizetype i = 0; i < value.size(); ++i) {
        const QChar current = value.at(i);
        if (current != QLatin1Char('\\') || i + 1 >= value.size()) {
            decoded.append(current);
            continue;
        }

        const QChar escaped = value.at(++i);
        switch (escaped.unicode()) {
        case 'n': decoded.append(QLatin1Char('\n')); break;
        case 'r': decoded.append(QLatin1Char('\r')); break;
        case 't': decoded.append(QLatin1Char('\t')); break;
        case '\\': decoded.append(QLatin1Char('\\')); break;
        case '\'': decoded.append(QLatin1Char('\'')); break;
        case '"': decoded.append(QLatin1Char('"')); break;
        case 'u': {
            if (i + 4 < value.size()) {
                bool ok = false;
                const ushort codePoint = value.mid(i + 1, 4).toUShort(&ok, 16);
                if (ok) {
                    decoded.append(QChar(codePoint));
                    i += 4;
                    break;
                }
            }
            decoded.append(escaped);
            break;
        }
        case 'x': {
            if (i + 2 < value.size()) {
                bool ok = false;
                const ushort codePoint = value.mid(i + 1, 2).toUShort(&ok, 16);
                if (ok) {
                    decoded.append(QChar(codePoint));
                    i += 2;
                    break;
                }
            }
            decoded.append(escaped);
            break;
        }
        case '\n': break;
        case '\r':
            if (i + 1 < value.size() && value.at(i + 1) == QLatin1Char('\n')) ++i;
            break;
        default:
            decoded.append(escaped);
            break;
        }
    }

    return decoded;
}

QString LegacyI18nCatalog::legacyKeyCandidate(const QString &nativeKey) {
    QString result;
    result.reserve(nativeKey.size() + 8);

    for (qsizetype i = 0; i < nativeKey.size(); ++i) {
        const QChar current = nativeKey.at(i);
        if (current == QLatin1Char('.') || current == QLatin1Char('-')) {
            if (!result.isEmpty() && result.back() != QLatin1Char('_')) {
                result.append(QLatin1Char('_'));
            }
            continue;
        }

        if (current.isUpper()
            && !result.isEmpty()
            && result.back() != QLatin1Char('_')
            && i > 0
            && (nativeKey.at(i - 1).isLower() || nativeKey.at(i - 1).isDigit())) {
            result.append(QLatin1Char('_'));
        }
        result.append(current.toLower());
    }

    return result;
}
