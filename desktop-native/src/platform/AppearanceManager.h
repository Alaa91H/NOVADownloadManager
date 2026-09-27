#pragma once

#include <QObject>

class AppearanceManager final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool systemDark READ systemDark NOTIFY systemThemeChanged)

public:
    explicit AppearanceManager(QObject *parent = nullptr);

    bool systemDark() const noexcept { return m_systemDark; }

signals:
    void systemThemeChanged();

private:
    void updateSystemTheme();

    bool m_systemDark{true};
};
