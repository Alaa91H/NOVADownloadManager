#pragma once

#include <QAbstractListModel>
#include <QJsonArray>
#include <QString>
#include <QVariantMap>
#include <QVector>

class DownloadListModel final : public QAbstractListModel {
    Q_OBJECT
    Q_PROPERTY(int count READ count NOTIFY summaryChanged)
    Q_PROPERTY(int totalCount READ totalCount NOTIFY summaryChanged)
    Q_PROPERTY(int activeCount READ activeCount NOTIFY summaryChanged)
    Q_PROPERTY(qint64 totalSpeed READ totalSpeed NOTIFY summaryChanged)
    Q_PROPERTY(QString filterState READ filterState WRITE setFilterState NOTIFY filterChanged)
    Q_PROPERTY(QString searchQuery READ searchQuery WRITE setSearchQuery NOTIFY filterChanged)

public:
    enum Role {
        IdRole = Qt::UserRole + 1,
        NameRole,
        UrlRole,
        StatusRole,
        SizeBytesRole,
        DownloadedBytesRole,
        ProgressRole,
        SpeedRole,
        EtaRole,
        SavePathRole,
        EngineRole,
        CategoryRole,
        ConnectionsRole,
        ResumableRole,
        DateAddedRole,
        ErrorMessageRole
    };
    Q_ENUM(Role)

    explicit DownloadListModel(QObject *parent = nullptr);

    int rowCount(const QModelIndex &parent = QModelIndex()) const override;
    QVariant data(const QModelIndex &index, int role = Qt::DisplayRole) const override;
    QHash<int, QByteArray> roleNames() const override;

    int count() const noexcept { return m_items.size(); }
    int totalCount() const noexcept { return m_allItems.size(); }
    int activeCount() const noexcept;
    qint64 totalSpeed() const noexcept;

    QString filterState() const { return m_filterState; }
    QString searchQuery() const { return m_searchQuery; }

    void setFilterState(const QString &filterState);
    void setSearchQuery(const QString &searchQuery);

    Q_INVOKABLE QString taskIdAt(int row) const;
    Q_INVOKABLE QVariantMap itemAt(int row) const;
    Q_INVOKABLE QVariantMap itemById(const QString &taskId) const;

public slots:
    void replaceFromJson(const QJsonArray &downloads);

signals:
    void summaryChanged();
    void filterChanged();

private:
    struct Item {
        QString id;
        QString name;
        QString url;
        QString status;
        qint64 sizeBytes{0};
        qint64 downloadedBytes{0};
        qreal progress{0.0};
        qint64 speedBytesPerSec{0};
        int etaSeconds{0};
        QString savePath;
        QString engine;
        QString category;
        int connections{0};
        bool resumable{false};
        QString dateAdded;
        QString errorMessage;
    };

    static bool isActiveStatus(const QString &status);
    bool matchesCurrentFilter(const Item &item) const;
    void rebuildVisibleItems();

    QVector<Item> m_allItems;
    QVector<Item> m_items;
    QString m_filterState{QStringLiteral("downloads")};
    QString m_searchQuery;
};
