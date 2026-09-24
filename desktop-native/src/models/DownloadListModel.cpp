#include "models/DownloadListModel.h"

#include <QJsonObject>

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
    case StatusRole: return item.status;
    case SizeBytesRole: return item.sizeBytes;
    case DownloadedBytesRole: return item.downloadedBytes;
    case ProgressRole: return item.progress;
    case SpeedRole: return item.speedBytesPerSec;
    case EtaRole: return item.etaSeconds;
    case SavePathRole: return item.savePath;
    case EngineRole: return item.engine;
    default: return {};
    }
}

QHash<int, QByteArray> DownloadListModel::roleNames() const {
    return {
        {IdRole, "taskId"},
        {NameRole, "name"},
        {StatusRole, "status"},
        {SizeBytesRole, "sizeBytes"},
        {DownloadedBytesRole, "downloadedBytes"},
        {ProgressRole, "progress"},
        {SpeedRole, "speedBytesPerSec"},
        {EtaRole, "etaSeconds"},
        {SavePathRole, "savePath"},
        {EngineRole, "engine"}
    };
}

int DownloadListModel::activeCount() const noexcept {
    int count = 0;
    for (const auto &item : m_items) {
        if (item.status == QStringLiteral("downloading") ||
            item.status == QStringLiteral("preparing") ||
            item.status == QStringLiteral("probing") ||
            item.status == QStringLiteral("retrying") ||
            item.status == QStringLiteral("recovering") ||
            item.status == QStringLiteral("verifying") ||
            item.status == QStringLiteral("finalizing")) {
            ++count;
        }
    }
    return count;
}

qint64 DownloadListModel::totalSpeed() const noexcept {
    qint64 speed = 0;
    for (const auto &item : m_items) {
        speed += item.speedBytesPerSec;
    }
    return speed;
}

void DownloadListModel::replaceFromJson(const QJsonArray &downloads) {
    QVector<Item> next;
    next.reserve(downloads.size());

    for (const auto &value : downloads) {
        const QJsonObject object = value.toObject();
        Item item;
        item.id = object.value(QStringLiteral("id")).toString();
        item.name = object.value(QStringLiteral("name")).toString();
        item.status = object.value(QStringLiteral("status")).toString();
        item.sizeBytes = object.value(QStringLiteral("sizeBytes")).toInteger();
        item.downloadedBytes = object.value(QStringLiteral("downloadedBytes")).toInteger();
        item.speedBytesPerSec = object.value(QStringLiteral("speedBytesPerSec")).toInteger();
        item.etaSeconds = object.value(QStringLiteral("timeLeftSeconds")).toInt();
        item.savePath = object.value(QStringLiteral("savePath")).toString();
        item.engine = object.value(QStringLiteral("engine")).toString();

        if (item.sizeBytes > 0) {
            item.progress = qBound<qreal>(0.0,
                static_cast<qreal>(item.downloadedBytes) / static_cast<qreal>(item.sizeBytes),
                1.0);
        }

        next.push_back(std::move(item));
    }

    beginResetModel();
    m_items = std::move(next);
    endResetModel();
    emit summaryChanged();
}
