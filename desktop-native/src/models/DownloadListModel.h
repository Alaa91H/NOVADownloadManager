#pragma once

#include <QAbstractListModel>
#include <QJsonArray>
#include <QString>
#include <QVector>

class DownloadListModel final : public QAbstractListModel {
    Q_OBJECT
    Q_PROPERTY(int count READ count NOTIFY summaryChanged)\n    Q_PROPERTY(int activeCount READ activeCount NOTIFY summaryChanged)
    Q_PROPERTY(qint64 totalSpeed READ totalSpeed NOTIFY summaryChanged)

public:
    enum Role {
        IdRole = Qt::UserRole + 1,
        NameRole,
        StatusRole,
        SizeBytesRole,
        DownloadedBytesRole,
        ProgressRole,
        SpeedRole,
        EtaRole,
        SavePathRole,
        EngineRole
    };
    Q_ENUM(Role)

    explicit DownloadListModel(QObject *parent = nullptr);

    int rowCount(const QModelIndex &parent = QModelIndex()) const override;
    QVariant data(const QModelIndex &index, int role = Qt::DisplayRole) const override;
    QHash<int, QByteArray> roleNames() const override;

    int count() const noexcept { return m_items.size(); }\n    Q_INVOKABLE QString taskIdAt(int row) const;\n    int activeCount() const noexcept;
    qint64 totalSpeed() const noexcept;

public slots:
    void replaceFromJson(const QJsonArray &downloads);

signals:
    void summaryChanged();

private:
    struct Item {
        QString id;
        QString name;
        QString status;
        qint64 sizeBytes{0};
        qint64 downloadedBytes{0};
        qreal progress{0.0};
        qint64 speedBytesPerSec{0};
        int etaSeconds{0};
        QString savePath;
        QString engine;
    };

    QVector<Item> m_items;
};
