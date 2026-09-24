#include "localization/I18nManager.h"

#include <QHash>
#include <QLocale>
#include <QVariantMap>

namespace {
using Dictionary = QHash<QString, QString>;

const Dictionary &english() {
    static const Dictionary values{
        {QStringLiteral("app.name"), QStringLiteral("NOVA Download Manager")},
        {QStringLiteral("nav.library"), QStringLiteral("LIBRARY")},
        {QStringLiteral("nav.tools"), QStringLiteral("TOOLS")},
        {QStringLiteral("nav.downloads"), QStringLiteral("Downloads")},
        {QStringLiteral("nav.active"), QStringLiteral("Active")},
        {QStringLiteral("nav.queued"), QStringLiteral("Queued")},
        {QStringLiteral("nav.completed"), QStringLiteral("Completed")},
        {QStringLiteral("nav.failed"), QStringLiteral("Failed")},
        {QStringLiteral("nav.queue"), QStringLiteral("Queue Manager")},
        {QStringLiteral("nav.batch"), QStringLiteral("Batch Import")},
        {QStringLiteral("nav.scheduler"), QStringLiteral("Scheduler")},
        {QStringLiteral("nav.media"), QStringLiteral("Media Downloader")},
        {QStringLiteral("nav.grabber"), QStringLiteral("Link Grabber")},
        {QStringLiteral("nav.settings"), QStringLiteral("Settings")},
        {QStringLiteral("menu.file"), QStringLiteral("File")},
        {QStringLiteral("menu.view"), QStringLiteral("View")},
        {QStringLiteral("menu.tools"), QStringLiteral("Tools")},
        {QStringLiteral("menu.help"), QStringLiteral("Help")},
        {QStringLiteral("action.newDownload"), QStringLiteral("New Download")},
        {QStringLiteral("action.refresh"), QStringLiteral("Refresh")},
        {QStringLiteral("action.quit"), QStringLiteral("Quit")},
        {QStringLiteral("action.checkUpdates"), QStringLiteral("Check for Updates")},
        {QStringLiteral("action.resume"), QStringLiteral("Resume")},
        {QStringLiteral("action.pause"), QStringLiteral("Pause")},
        {QStringLiteral("action.retry"), QStringLiteral("Retry")},
        {QStringLiteral("action.redownload"), QStringLiteral("Redownload")},
        {QStringLiteral("action.open"), QStringLiteral("Open")},
        {QStringLiteral("action.folder"), QStringLiteral("Folder")},
        {QStringLiteral("action.properties"), QStringLiteral("Properties")},
        {QStringLiteral("action.delete"), QStringLiteral("Delete")},
        {QStringLiteral("status.active"), QStringLiteral("active")},
        {QStringLiteral("status.downloads"), QStringLiteral("downloads")},
        {QStringLiteral("settings.title"), QStringLiteral("Settings & Diagnostics")},
        {QStringLiteral("settings.subtitle"), QStringLiteral("Native preferences, Rust engine controls and runtime diagnostics")},
        {QStringLiteral("settings.general"), QStringLiteral("General")},
        {QStringLiteral("settings.engine"), QStringLiteral("Engine")},
        {QStringLiteral("settings.diagnostics"), QStringLiteral("Diagnostics")},
        {QStringLiteral("settings.appearance"), QStringLiteral("Appearance & language")},
        {QStringLiteral("settings.language"), QStringLiteral("Language")},
        {QStringLiteral("settings.theme"), QStringLiteral("Theme")},
        {QStringLiteral("settings.system"), QStringLiteral("System")},
        {QStringLiteral("settings.light"), QStringLiteral("Light")},
        {QStringLiteral("settings.dark"), QStringLiteral("Dark")},
        {QStringLiteral("settings.highContrast"), QStringLiteral("High contrast")},
        {QStringLiteral("settings.reducedMotion"), QStringLiteral("Reduce motion")},
        {QStringLiteral("settings.fontScale"), QStringLiteral("Text scale")},
        {QStringLiteral("settings.downloadDefaults"), QStringLiteral("Download defaults")},
        {QStringLiteral("settings.desktopIntegration"), QStringLiteral("Desktop integration")},
        {QStringLiteral("settings.notifications"), QStringLiteral("Notifications")}
    };
    return values;
}

const Dictionary &arabic() {
    static const Dictionary values{
        {QStringLiteral("app.name"), QStringLiteral("مدير التنزيل NOVA")},
        {QStringLiteral("nav.library"), QStringLiteral("المكتبة")},
        {QStringLiteral("nav.tools"), QStringLiteral("الأدوات")},
        {QStringLiteral("nav.downloads"), QStringLiteral("التنزيلات")},
        {QStringLiteral("nav.active"), QStringLiteral("النشطة")},
        {QStringLiteral("nav.queued"), QStringLiteral("في قائمة الانتظار")},
        {QStringLiteral("nav.completed"), QStringLiteral("المكتملة")},
        {QStringLiteral("nav.failed"), QStringLiteral("الفاشلة")},
        {QStringLiteral("nav.queue"), QStringLiteral("إدارة قائمة الانتظار")},
        {QStringLiteral("nav.batch"), QStringLiteral("استيراد دفعة")},
        {QStringLiteral("nav.scheduler"), QStringLiteral("الجدولة")},
        {QStringLiteral("nav.media"), QStringLiteral("تنزيل الوسائط")},
        {QStringLiteral("nav.grabber"), QStringLiteral("التقاط الروابط")},
        {QStringLiteral("nav.settings"), QStringLiteral("الإعدادات")},
        {QStringLiteral("menu.file"), QStringLiteral("ملف")},
        {QStringLiteral("menu.view"), QStringLiteral("عرض")},
        {QStringLiteral("menu.tools"), QStringLiteral("أدوات")},
        {QStringLiteral("menu.help"), QStringLiteral("مساعدة")},
        {QStringLiteral("action.newDownload"), QStringLiteral("تنزيل جديد")},
        {QStringLiteral("action.refresh"), QStringLiteral("تحديث")},
        {QStringLiteral("action.quit"), QStringLiteral("خروج")},
        {QStringLiteral("action.checkUpdates"), QStringLiteral("التحقق من التحديثات")},
        {QStringLiteral("action.resume"), QStringLiteral("استئناف")},
        {QStringLiteral("action.pause"), QStringLiteral("إيقاف مؤقت")},
        {QStringLiteral("action.retry"), QStringLiteral("إعادة المحاولة")},
        {QStringLiteral("action.redownload"), QStringLiteral("إعادة التنزيل")},
        {QStringLiteral("action.open"), QStringLiteral("فتح")},
        {QStringLiteral("action.folder"), QStringLiteral("المجلد")},
        {QStringLiteral("action.properties"), QStringLiteral("الخصائص")},
        {QStringLiteral("action.delete"), QStringLiteral("حذف")},
        {QStringLiteral("status.active"), QStringLiteral("نشط")},
        {QStringLiteral("status.downloads"), QStringLiteral("تنزيلات")},
        {QStringLiteral("settings.title"), QStringLiteral("الإعدادات والتشخيص")},
        {QStringLiteral("settings.subtitle"), QStringLiteral("تفضيلات الواجهة الأصلية وتحكم محرك Rust وتشخيصات التشغيل")},
        {QStringLiteral("settings.general"), QStringLiteral("عام")},
        {QStringLiteral("settings.engine"), QStringLiteral("المحرك")},
        {QStringLiteral("settings.diagnostics"), QStringLiteral("التشخيص")},
        {QStringLiteral("settings.appearance"), QStringLiteral("المظهر واللغة")},
        {QStringLiteral("settings.language"), QStringLiteral("اللغة")},
        {QStringLiteral("settings.theme"), QStringLiteral("السمة")},
        {QStringLiteral("settings.system"), QStringLiteral("النظام")},
        {QStringLiteral("settings.light"), QStringLiteral("فاتح")},
        {QStringLiteral("settings.dark"), QStringLiteral("داكن")},
        {QStringLiteral("settings.highContrast"), QStringLiteral("تباين عالٍ")},
        {QStringLiteral("settings.reducedMotion"), QStringLiteral("تقليل الحركة")},
        {QStringLiteral("settings.fontScale"), QStringLiteral("حجم النص")},
        {QStringLiteral("settings.downloadDefaults"), QStringLiteral("إعدادات التنزيل الافتراضية")},
        {QStringLiteral("settings.desktopIntegration"), QStringLiteral("تكامل سطح المكتب")},
        {QStringLiteral("settings.notifications"), QStringLiteral("الإشعارات")}
    };
    return values;
}

const Dictionary &german() {
    static const Dictionary values{
        {QStringLiteral("app.name"), QStringLiteral("NOVA Download Manager")},
        {QStringLiteral("nav.library"), QStringLiteral("BIBLIOTHEK")},
        {QStringLiteral("nav.tools"), QStringLiteral("WERKZEUGE")},
        {QStringLiteral("nav.downloads"), QStringLiteral("Downloads")},
        {QStringLiteral("nav.active"), QStringLiteral("Aktiv")},
        {QStringLiteral("nav.queued"), QStringLiteral("Warteschlange")},
        {QStringLiteral("nav.completed"), QStringLiteral("Abgeschlossen")},
        {QStringLiteral("nav.failed"), QStringLiteral("Fehlgeschlagen")},
        {QStringLiteral("nav.queue"), QStringLiteral("Warteschlange")},
        {QStringLiteral("nav.batch"), QStringLiteral("Stapelimport")},
        {QStringLiteral("nav.scheduler"), QStringLiteral("Zeitplanung")},
        {QStringLiteral("nav.media"), QStringLiteral("Medien-Downloader")},
        {QStringLiteral("nav.grabber"), QStringLiteral("Link-Grabber")},
        {QStringLiteral("nav.settings"), QStringLiteral("Einstellungen")},
        {QStringLiteral("menu.file"), QStringLiteral("Datei")},
        {QStringLiteral("menu.view"), QStringLiteral("Ansicht")},
        {QStringLiteral("menu.tools"), QStringLiteral("Werkzeuge")},
        {QStringLiteral("menu.help"), QStringLiteral("Hilfe")},
        {QStringLiteral("action.newDownload"), QStringLiteral("Neuer Download")},
        {QStringLiteral("action.refresh"), QStringLiteral("Aktualisieren")},
        {QStringLiteral("action.quit"), QStringLiteral("Beenden")},
        {QStringLiteral("action.checkUpdates"), QStringLiteral("Nach Updates suchen")},
        {QStringLiteral("action.resume"), QStringLiteral("Fortsetzen")},
        {QStringLiteral("action.pause"), QStringLiteral("Pausieren")},
        {QStringLiteral("action.retry"), QStringLiteral("Erneut versuchen")},
        {QStringLiteral("action.redownload"), QStringLiteral("Neu herunterladen")},
        {QStringLiteral("action.open"), QStringLiteral("Öffnen")},
        {QStringLiteral("action.folder"), QStringLiteral("Ordner")},
        {QStringLiteral("action.properties"), QStringLiteral("Eigenschaften")},
        {QStringLiteral("action.delete"), QStringLiteral("Löschen")},
        {QStringLiteral("status.active"), QStringLiteral("aktiv")},
        {QStringLiteral("status.downloads"), QStringLiteral("Downloads")},
        {QStringLiteral("settings.title"), QStringLiteral("Einstellungen & Diagnose")},
        {QStringLiteral("settings.subtitle"), QStringLiteral("Native Einstellungen, Rust-Engine-Steuerung und Laufzeitdiagnose")},
        {QStringLiteral("settings.general"), QStringLiteral("Allgemein")},
        {QStringLiteral("settings.engine"), QStringLiteral("Engine")},
        {QStringLiteral("settings.diagnostics"), QStringLiteral("Diagnose")},
        {QStringLiteral("settings.appearance"), QStringLiteral("Darstellung & Sprache")},
        {QStringLiteral("settings.language"), QStringLiteral("Sprache")},
        {QStringLiteral("settings.theme"), QStringLiteral("Design")},
        {QStringLiteral("settings.system"), QStringLiteral("System")},
        {QStringLiteral("settings.light"), QStringLiteral("Hell")},
        {QStringLiteral("settings.dark"), QStringLiteral("Dunkel")},
        {QStringLiteral("settings.highContrast"), QStringLiteral("Hoher Kontrast")},
        {QStringLiteral("settings.reducedMotion"), QStringLiteral("Bewegung reduzieren")},
        {QStringLiteral("settings.fontScale"), QStringLiteral("Textskalierung")},
        {QStringLiteral("settings.downloadDefaults"), QStringLiteral("Download-Standardwerte")},
        {QStringLiteral("settings.desktopIntegration"), QStringLiteral("Desktop-Integration")},
        {QStringLiteral("settings.notifications"), QStringLiteral("Benachrichtigungen")}
    };
    return values;
}
}

I18nManager::I18nManager(QObject *parent)
    : QObject(parent) {}

QString I18nManager::normalizeLanguage(const QString &language) {
    QString normalized = language.trimmed().toLower();
    if (normalized == QStringLiteral("system") || normalized.isEmpty()) {
        normalized = QLocale::system().name().section(QLatin1Char('_'), 0, 0).toLower();
    }

    if (normalized.startsWith(QStringLiteral("ar"))) {
        return QStringLiteral("ar");
    }
    if (normalized.startsWith(QStringLiteral("de"))) {
        return QStringLiteral("de");
    }
    return QStringLiteral("en");
}

void I18nManager::setLanguage(const QString &language) {
    const QString normalized = normalizeLanguage(language);
    if (m_language == normalized) {
        return;
    }
    m_language = normalized;
    emit languageChanged();
}

QVariantList I18nManager::supportedLanguages() const {
    return {
        QVariantMap{{QStringLiteral("code"), QStringLiteral("system")},
                    {QStringLiteral("label"), QStringLiteral("System")}},
        QVariantMap{{QStringLiteral("code"), QStringLiteral("en")},
                    {QStringLiteral("label"), QStringLiteral("English")}},
        QVariantMap{{QStringLiteral("code"), QStringLiteral("ar")},
                    {QStringLiteral("label"), QStringLiteral("العربية")}},
        QVariantMap{{QStringLiteral("code"), QStringLiteral("de")},
                    {QStringLiteral("label"), QStringLiteral("Deutsch")}}
    };
}

QString I18nManager::translate(const QString &key) const {
    const Dictionary *dictionary = &english();
    if (m_language == QStringLiteral("ar")) {
        dictionary = &arabic();
    } else if (m_language == QStringLiteral("de")) {
        dictionary = &german();
    }

    const auto it = dictionary->constFind(key);
    if (it != dictionary->constEnd()) {
        return it.value();
    }

    const auto fallback = english().constFind(key);
    return fallback != english().constEnd() ? fallback.value() : key;
}
