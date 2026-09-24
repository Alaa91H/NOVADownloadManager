#include "models/DownloadListModel.h"

#include <algorithm>
#include <QJsonObject>
#include <QSet>
#include <QtGlobal>

DownloadListModel::DownloadListModel(QObject *parent)
    : QAbstractListModel(parent) {}

int DownloadListModel::rowCount(const QModelIndex &parent) const {
    return parent.isValid() ? 0 : m_items.size();
}

QVariant DownloadListModel::data(const QModelIndex &index, int role) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= m_items.size()) {
        return {};
    }

    const Item &item = m_items.at(index.row());
    switch (role) {
    case IdRole: return item.id;
    case NameRole: return item.name;
    case UrlRole: return item.url;
    case StatusRole: return item.status;
    case SizeBytesRole: return item.sizeBytes;
    case DownloadedBytesRole: return item.downloadedBytes;
    case ProgressRole: return item.progress;
    case SpeedRole: return item.speedBytesPerSec;
    case EtaRole: return item.etaSeconds;
    case SavePathRole: return item.savePath;
    case EngineRole: return item.engine;
    case CategoryRole: return item.category;
    case ConnectionsRole: return item.connections;
    case ResumableRole: return item.resumable;
    case DateAddedRole: return item.dateAdded;
    case ErrorMessageRole: return item.errorMessage;
    default: return {};
    }
}

QHash<int, QByteArray> DownloadListModel::roleNames() const {
    return {
        {IdRole, "taskId"},
        {NameRole, "name"},
        {UrlRole, "url"},
        {StatusRole, "status"},
        {SizeBytesRole, "sizeBytes"},
        {DownloadedBytesRole, "downloadedBytes"},
        {ProgressRole, "progress"},
        {SpeedRole, "speedBytesPerSec"},
        {EtaRole, "etaSeconds"},
        {SavePathRole, "savePath"},
        {EngineRole, "engine"},
        {CategoryRole, "category"},
        {ConnectionsRole, "connections"},
        {ResumableRole, "resumable"},
        {DateAddedRole, "dateAdded"},
        {ErrorMessageRole, "errorMessage"}
    };
}

QString DownloadListModel::taskIdAt(int row) const {
    if (row < 0 || row >= m_items.size()) {
        return {};
    }
    return m_items.at(row).id;
}

QVariantMap DownloadListModel::itemAt(int row) const {
    if (row < 0 || row >= m_items.size()) {
        return {};
    }

    const Item &item = m_items.at(row);
    QVariantMap result;
    result.insert(QStringLiteral("taskId"), item.id);
    result.insert(QStringLiteral("name"), item.name);
    result.insert(QStringLiteral("url"), item.url);
    result.insert(QStringLiteral("status"), item.status);
    result.insert(QStringLiteral("sizeBytes"), item.sizeBytes);
    result.insert(QStringLiteral("downloadedBytes"), item.downloadedBytes);
    result.insert(QStringLiteral("progress"), item.progress);
    result.insert(QStringLiteral("speedBytesPerSec"), item.speedBytesPerSec);
    result.insert(QStringLiteral("etaSeconds"), item.etaSeconds);
    result.insert(QStringLiteral("savePath"), item.savePath);
    result.insert(QStringLiteral("engine"), item.engine);
    result.insert(QStringLiteral("category"), item.category);
    result.insert(QStringLiteral("connections"), item.connections);
    result.insert(QStringLiteral("resumable"), item.resumable);
    result.insert(QStringLiteral("dateAdded"), item.dateAdded);
    result.insert(QStringLiteral("errorMessage"), item.errorMessage);
    return result;
}


QVariantMap DownloadListModel::itemById(const QString &taskId) const {
    for (const Item &item : m_allItems) {
        if (item.id != taskId) {
            continue;
        }

        QVariantMap result;
        result.insert(QStringLiteral("taskId"), item.id);
        result.insert(QStringLiteral("name"), item.name);
        result.insert(QStringLiteral("url"), item.url);
        result.insert(QStringLiteral("status"), item.status);
        result.insert(QStringLiteral("sizeBytes"), item.sizeBytes);
        result.insert(QStringLiteral("downloadedBytes"), item.downloadedBytes);
        result.insert(QStringLiteral("progress"), item.progress);
        result.insert(QStringLiteral("speedBytesPerSec"), item.speedBytesPerSec);
        result.insert(QStringLiteral("etaSeconds"), item.etaSeconds);
        result.insert(QStringLiteral("savePath"), item.savePath);
        result.insert(QStringLiteral("engine"), item.engine);
        result.insert(QStringLiteral("category"), item.category);
        result.insert(QStringLiteral("connections"), item.connections);
        result.insert(QStringLiteral("resumable"), item.resumable);
        result.insert(QStringLiteral("dateAdded"), item.dateAdded);
        result.insert(QStringLiteral("errorMessage"), item.errorMessage);
        return result;
    }

    return {};
}

bool DownloadListModel::isActiveStatus(const QString &status) {
    const QString normalized = status.trimmed().toLower();
    return normalized == QStringLiteral("downloading")
        || normalized == QStringLiteral("preparing")
        || normalized == QStringLiteral("probing")
        || normalized == QStringLiteral("retrying")
        || normalized == QStringLiteral("recovering")
        || normalized == QStringLiteral("verifying")
        || normalized == QStringLiteral("finalizing");
}

int DownloadListModel::activeCount() const noexcept {
    int result = 0;
    for (const auto &item : m_allItems) {
        if (isActiveStatus(item.status)) {
            ++result;
        }
    }
    return result;
}

qint64 DownloadListModel::totalSpeed() const noexcept {
    qint64 speed = 0;
    for (const auto &item : m_allItems) {
        speed += item.speedBytesPerSec;
    }
    return speed;
}

void DownloadListModel::setFilterState(const QString &filterState) {
    const QString normalized = filterState.trimmed().toLower();
    const QString next = normalized.isEmpty() ? QStringLiteral("downloads") : normalized;
    if (m_filterState == next) {
        return;
    }

    m_filterState = next;
    rebuildVisibleItems();
    emit filterChanged();
}

void DownloadListModel::setSearchQuery(const QString &searchQuery) {
    const QString next = searchQuery.trimmed();
    if (m_searchQuery == next) {
        return;
    }

    m_searchQuery = next;
    rebuildVisibleItems();
    emit filterChanged();
}

void DownloadListModel::setSortKey(const QString &sortKey) {
    static const QSet<QString> allowed{
        QStringLiteral("name"),
        QStringLiteral("size"),
        QStringLiteral("progress"),
        QStringLiteral("speed"),
        QStringLiteral("eta"),
        QStringLiteral("status"),
        QStringLiteral("dateAdded"),
        QStringLiteral("engine")
    };

    const QString normalized = allowed.contains(sortKey.trimmed())
        ? sortKey.trimmed()
        : QStringLiteral("dateAdded");
    if (m_sortKey == normalized) {
        return;
    }

    m_sortKey = normalized;
    rebuildVisibleItems();
    emit sortChanged();
}

void DownloadListModel::setSortAscending(bool ascending) {
    if (m_sortAscending == ascending) {
        return;
    }

    m_sortAscending = ascending;
    rebuildVisibleItems();
    emit sortChanged();
}

bool DownloadListModel::matchesCurrentFilter(const Item &item) const {
    const QString state = m_filterState;
    const QString status = item.status.trimmed().toLower();

    bool statusMatch = true;
    if (state == QStringLiteral("active")) {
        statusMatch = isActiveStatus(status);
    } else if (state == QStringLiteral("queued")) {
        statusMatch = status == QStringLiteral("queued") || status == QStringLiteral("paused");
    } else if (state == QStringLiteral("completed")) {
        statusMatch = status == QStringLiteral("completed");
    } else if (state == QStringLiteral("failed")) {
        statusMatch = status == QStringLiteral("failed")
            || status == QStringLiteral("error")
            || status == QStringLiteral("cancelled");
    }

    if (!statusMatch) {
        return false;
    }

    if (m_searchQuery.isEmpty()) {
        return true;
    }

    const QString needle = m_searchQuery;
    return item.name.contains(needle, Qt::CaseInsensitive)
        || item.url.contains(needle, Qt::CaseInsensitive)
        || item.savePath.contains(needle, Qt::CaseInsensitive)
        || item.engine.contains(needle, Qt::CaseInsensitive)
        || item.status.contains(needle, Qt::CaseInsensitive);
}

int DownloadListModel::compareItems(
    const Item &left,
    const Item &right,
    const QString &sortKey
) {
    const auto compareNumber = [](auto a, auto b) {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    };

    if (sortKey == QStringLiteral("name")) {
        return QString::localeAwareCompare(left.name.toLower(), right.name.toLower());
    }
    if (sortKey == QStringLiteral("size")) {
        return compareNumber(left.sizeBytes, right.sizeBytes);
    }
    if (sortKey == QStringLiteral("progress")) {
        return compareNumber(left.progress, right.progress);
    }
    if (sortKey == QStringLiteral("speed")) {
        return compareNumber(left.speedBytesPerSec, right.speedBytesPerSec);
    }
    if (sortKey == QStringLiteral("eta")) {
        return compareNumber(left.etaSeconds, right.etaSeconds);
    }
    if (sortKey == QStringLiteral("status")) {
        return QString::localeAwareCompare(left.status.toLower(), right.status.toLower());
    }
    if (sortKey == QStringLiteral("engine")) {
        return QString::localeAwareCompare(left.engine.toLower(), right.engine.toLower());
    }

    return QString::compare(left.dateAdded, right.dateAdded, Qt::CaseInsensitive);
}

void DownloadListModel::rebuildVisibleItems() {
    QVector<Item> filtered;
    filtered.reserve(m_allItems.size());

    for (const auto &item : m_allItems) {
        if (matchesCurrentFilter(item)) {
            filtered.push_back(item);
        }
    }

    std::stable_sort(
        filtered.begin(),
        filtered.end(),
        [this](const Item &left, const Item &right) {
            int comparison = compareItems(left, right, m_sortKey);
            if (comparison == 0) {
                comparison = QString::compare(left.id, right.id, Qt::CaseInsensitive);
            }
            return m_sortAscending ? comparison < 0 : comparison > 0;
        }
    );

    beginResetModel();
    m_items = std::move(filtered);
    endResetModel();
    emit summaryChanged();
}

void DownloadListModel::replaceFromJson(const QJsonArray &downloads) {
    QVector<Item> next;
    next.reserve(downloads.size());

    for (const auto &value : downloads) {
        const QJsonObject object = value.toObject();
        Item item;
        item.id = object.value(QStringLiteral("id")).toString();
        item.name = object.value(QStringLiteral("name")).toString();
        item.url = object.value(QStringLiteral("url")).toString();
        item.status = object.value(QStringLiteral("status")).toString();
        item.sizeBytes = object.value(QStringLiteral("sizeBytes")).toInteger();
        item.downloadedBytes = object.value(QStringLiteral("downloadedBytes")).toInteger();
        item.speedBytesPerSec = object.value(QStringLiteral("speedBytesPerSec")).toInteger();
        item.etaSeconds = object.value(QStringLiteral("timeLeftSeconds")).toInt();
        item.savePath = object.value(QStringLiteral("savePath")).toString();
        item.engine = object.value(QStringLiteral("engine")).toString();
        item.category = object.value(QStringLiteral("category")).toString();
        item.connections = object.value(QStringLiteral("connections")).toInt();
        item.resumable = object.value(QStringLiteral("resumable")).toBool();
        item.dateAdded = object.value(QStringLiteral("dateAdded")).toString();
        item.errorMessage = object.value(QStringLiteral("errorMessage")).toString();

        if (item.sizeBytes > 0) {
            item.progress = qBound<qreal>(
                0.0,
                static_cast<qreal>(item.downloadedBytes) / static_cast<qreal>(item.sizeBytes),
                1.0
            );
        }

        next.push_back(std::move(item));
    }

    m_allItems = std::move(next);
    rebuildVisibleItems();
}
