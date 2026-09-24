#pragma once

#include <QString>
#include <QStringList>

namespace Nova::BatchPattern {

constexpr int MaxExpandedUrls = 10'000;

struct ExpansionResult {
    QStringList urls;
    QString error;

    bool ok() const noexcept { return error.isEmpty(); }
};

ExpansionResult expandInput(const QString &input);

} // namespace Nova::BatchPattern
