#include "batch/BatchPatternExpander.h"

#include <QList>
#include <QRegularExpression>
#include <QtGlobal>

#include <utility>

namespace Nova::BatchPattern {
namespace {

enum class BracketKind {
    Literal,
    Numeric,
    Alpha,
};

struct Bracket {
    BracketKind kind{BracketKind::Literal};
    QString literal;
    qint64 low{0};
    qint64 high{0};
    qint64 step{1};
    int padWidth{0};
};

struct Group {
    QString prefix;
    Bracket bracket;
};

Bracket parseBracket(QString raw) {
    qint64 step = 1;
    const int stepIndex = raw.lastIndexOf(QLatin1Char(':'));
    if (stepIndex >= 0) {
        bool stepOk = false;
        const qint64 parsedStep = raw.mid(stepIndex + 1).toLongLong(&stepOk);
        if (stepOk && parsedStep > 0) {
            step = parsedStep;
        }
        // The legacy parser treats an invalid/non-positive step suffix as the
        // default step=1 while still parsing the underlying range.
        raw = raw.left(stepIndex);
    }

    const int dashIndex = raw.indexOf(QLatin1Char('-'));
    if (dashIndex < 0) {
        return Bracket{BracketKind::Literal, raw};
    }

    const QString startText = raw.left(dashIndex);
    const QString endText = raw.mid(dashIndex + 1);

    bool startNumberOk = false;
    bool endNumberOk = false;
    const qint64 startNumber = startText.toLongLong(&startNumberOk);
    const qint64 endNumber = endText.toLongLong(&endNumberOk);

    if (startNumberOk && endNumberOk) {
        Bracket result;
        result.kind = BracketKind::Numeric;
        result.low = qMin(startNumber, endNumber);
        result.high = qMax(startNumber, endNumber);
        result.step = step;
        result.padWidth = qMax(startText.size(), endText.size());
        return result;
    }

    if (startText.size() == 1 && endText.size() == 1) {
        Bracket result;
        result.kind = BracketKind::Alpha;
        result.low = qMin(startText.at(0).unicode(), endText.at(0).unicode());
        result.high = qMax(startText.at(0).unicode(), endText.at(0).unicode());
        result.step = step;
        return result;
    }

    return Bracket{BracketKind::Literal, raw};
}

qint64 bracketCount(const Bracket &bracket) {
    if (bracket.kind == BracketKind::Literal) {
        return 1;
    }
    return ((bracket.high - bracket.low) / bracket.step) + 1;
}

QStringList bracketValues(const Bracket &bracket) {
    if (bracket.kind == BracketKind::Literal) {
        return {bracket.literal};
    }

    QStringList values;
    const qint64 count = bracketCount(bracket);
    values.reserve(static_cast<qsizetype>(qMin<qint64>(count, MaxExpandedUrls)));

    if (bracket.kind == BracketKind::Numeric) {
        for (qint64 value = bracket.low; value <= bracket.high; value += bracket.step) {
            QString rendered = QString::number(value);
            if (value >= 0 && rendered.size() < bracket.padWidth) {
                rendered = rendered.rightJustified(bracket.padWidth, QLatin1Char('0'));
            }
            values.append(rendered);
        }
        return values;
    }

    for (qint64 value = bracket.low; value <= bracket.high; value += bracket.step) {
        values.append(QString(1, QChar(static_cast<char16_t>(value))));
    }
    return values;
}

bool parsePattern(
    const QString &input,
    QList<Group> *groups,
    QString *trailing,
    QString *error
) {
    static const QRegularExpression pattern(QStringLiteral(R"(\[([^\]]+)\])"));
    QRegularExpressionMatchIterator iterator = pattern.globalMatch(input);
    int cursor = 0;

    while (iterator.hasNext()) {
        const QRegularExpressionMatch match = iterator.next();
        Group group;
        group.prefix = input.mid(cursor, match.capturedStart() - cursor);
        group.bracket = parseBracket(match.captured(1));
        groups->append(group);
        cursor = match.capturedEnd();
    }

    *trailing = input.mid(cursor);
    if (groups->isEmpty()) {
        return true;
    }

    qint64 total = 1;
    for (const Group &group : std::as_const(*groups)) {
        const qint64 count = bracketCount(group.bracket);
        if (count <= 0 || count > MaxExpandedUrls || total > MaxExpandedUrls / count) {
            *error = QStringLiteral(
                "Pattern expands to too many URLs (max %1)."
            ).arg(MaxExpandedUrls);
            return false;
        }
        total *= count;
    }
    return true;
}

CountResult countLine(const QString &line) {
    if (!line.contains(QLatin1Char('['))) {
        return CountResult{1, {}};
    }

    QList<Group> groups;
    QString trailing;
    QString error;
    if (!parsePattern(line, &groups, &trailing, &error)) {
        return CountResult{0, error};
    }
    if (groups.isEmpty()) {
        return CountResult{1, {}};
    }

    qint64 total = 1;
    for (const Group &group : std::as_const(groups)) {
        const qint64 count = bracketCount(group.bracket);
        if (count <= 0 || count > MaxExpandedUrls || total > MaxExpandedUrls / count) {
            return CountResult{
                0,
                QStringLiteral("Pattern expands to too many URLs (max %1).")
                    .arg(MaxExpandedUrls)
            };
        }
        total *= count;
    }
    return CountResult{total, {}};
}

ExpansionResult expandLine(const QString &line) {
    if (!line.contains(QLatin1Char('['))) {
        return ExpansionResult{{line}, {}};
    }

    QList<Group> groups;
    QString trailing;
    QString error;
    if (!parsePattern(line, &groups, &trailing, &error)) {
        return ExpansionResult{{}, error};
    }
    if (groups.isEmpty()) {
        return ExpansionResult{{line}, {}};
    }

    QStringList results{QString()};
    for (const Group &group : std::as_const(groups)) {
        const QStringList values = bracketValues(group.bracket);
        QStringList next;
        if (results.size() > MaxExpandedUrls / qMax(1, values.size())) {
            return ExpansionResult{
                {},
                QStringLiteral("Pattern expands to too many URLs (max %1).")
                    .arg(MaxExpandedUrls)
            };
        }
        next.reserve(results.size() * values.size());
        for (const QString &base : std::as_const(results)) {
            for (const QString &value : values) {
                next.append(base + group.prefix + value);
            }
        }
        results = std::move(next);
    }

    for (QString &result : results) {
        result += trailing;
    }
    return ExpansionResult{results, {}};
}

} // namespace

CountResult countInput(const QString &input) {
    qint64 total = 0;
    const QStringList lines = input.split(
        QRegularExpression(QStringLiteral("[\\r\\n]+")),
        Qt::SkipEmptyParts
    );

    for (const QString &raw : lines) {
        const QString line = raw.trimmed();
        if (line.isEmpty()) {
            continue;
        }

        const CountResult lineCount = countLine(line);
        if (!lineCount.ok()) {
            return lineCount;
        }
        if (lineCount.count > MaxExpandedUrls
            || total > MaxExpandedUrls - lineCount.count) {
            return CountResult{
                0,
                QStringLiteral("Pattern expands to too many URLs (max %1).")
                    .arg(MaxExpandedUrls)
            };
        }
        total += lineCount.count;
    }
    return CountResult{total, {}};
}

ExpansionResult expandInput(const QString &input) {
    QStringList output;
    const QStringList lines = input.split(
        QRegularExpression(QStringLiteral("[\\r\\n]+")),
        Qt::SkipEmptyParts
    );

    for (const QString &raw : lines) {
        const QString line = raw.trimmed();
        if (line.isEmpty()) {
            continue;
        }

        ExpansionResult expanded = expandLine(line);
        if (!expanded.ok()) {
            return expanded;
        }
        if (output.size() > MaxExpandedUrls - expanded.urls.size()) {
            return ExpansionResult{
                {},
                QStringLiteral("Pattern expands to too many URLs (max %1).")
                    .arg(MaxExpandedUrls)
            };
        }
        output.reserve(output.size() + expanded.urls.size());
        for (const QString &url : std::as_const(expanded.urls)) {
            output.append(url);
        }
    }

    return ExpansionResult{output, {}};
}

} // namespace Nova::BatchPattern
