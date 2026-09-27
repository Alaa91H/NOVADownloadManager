#include "platform/AppearanceManager.h"

#include <QGuiApplication>
#include <QStyleHints>

AppearanceManager::AppearanceManager(QObject *parent)
    : QObject(parent) {
    updateSystemTheme();

    if (auto *hints = QGuiApplication::styleHints()) {
        connect(
            hints,
            &QStyleHints::colorSchemeChanged,
            this,
            [this](Qt::ColorScheme) { updateSystemTheme(); }
        );
    }
}

void AppearanceManager::updateSystemTheme() {
    bool dark = true;
    if (auto *hints = QGuiApplication::styleHints()) {
        dark = hints->colorScheme() == Qt::ColorScheme::Dark;
    }

    if (m_systemDark == dark) {
        return;
    }
    m_systemDark = dark;
    emit systemThemeChanged();
}
