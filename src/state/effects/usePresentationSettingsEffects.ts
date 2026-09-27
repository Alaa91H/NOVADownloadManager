import { useEffect } from 'react';
import { getLanguageDirection } from '../../lib/i18n/languageMetadata';
import { isLanguageLoaded, loadLanguage } from '../../lib/i18n/translations';
import { settingsStore } from '../../store/settingsStore';
import type { AppSettings } from '../../types/desktop-ui.types';
import { logger } from '../../utils/logger';

function applyTheme(
  themeSettings: { theme: string; density: string; accent: string; progress: string; contrast: string },
  language: string,
) {
  const root = document.documentElement;
  let activeTheme = themeSettings.theme;
  if (activeTheme === 'system') {
    activeTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', activeTheme);
  root.setAttribute('data-density', themeSettings.density);
  root.setAttribute('data-accent', themeSettings.accent);
  root.setAttribute('data-progress', themeSettings.progress);
  root.setAttribute('data-contrast', themeSettings.contrast);
  root.setAttribute('dir', getLanguageDirection(language));
  root.setAttribute('lang', language || 'en');
}

function persistSettings(
  settings: AppSettings,
  themeSettings: { theme: string; density: string; accent: string; progress: string; contrast: string },
) {
  const timer = window.setTimeout(() => {
    const safeSettings = {
      ...settings,
      connection: { ...settings.connection, proxyUser: '', proxyPass: '' },
      extra: { ...settings.extra, tgBotToken: '', tgChatId: '', smtpUser: '', smtpPass: '' },
    };
    localStorage.setItem('nova_settings_v1', JSON.stringify(safeSettings));
    localStorage.setItem('nova_theme_settings_v1', JSON.stringify(themeSettings));
  }, 300);
  return () => {
    window.clearTimeout(timer);
  };
}

/** Keeps presentation-only settings effects separate from daemon synchronization. */
export function usePresentationSettingsEffects() {
  useEffect(() => {
    const unsubscribe = settingsStore.subscribe((state, previous) => {
      if (
        state.themeSettings !== previous.themeSettings ||
        state.settings.extra.language !== previous.settings.extra.language
      ) {
        applyTheme(state.themeSettings, state.settings.extra.language || 'en');
      }
    });
    const { themeSettings, settings } = settingsStore.getState();
    applyTheme(themeSettings, settings.extra.language || 'en');
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = settingsStore.subscribe((state, previous) => {
      if (state.settings.extra.language !== previous.settings.extra.language) {
        const language = state.settings.extra.language || 'en';
        if (!isLanguageLoaded(language)) {
          void loadLanguage(language).then(() => {
            settingsStore.getState().incrementI18nRevision();
          });
        }
      }
    });
    const language = settingsStore.getState().settings.extra.language || 'en';
    if (!isLanguageLoaded(language)) {
      void loadLanguage(language).then(() => {
        settingsStore.getState().incrementI18nRevision();
      });
    }
    return unsubscribe;
  }, []);

  useEffect(() => {
    const { loggingEnabled, logLevel } = settingsStore.getState().settings.advanced;
    logger.setEnabled(loggingEnabled);
    logger.setMinLevel(logLevel);
    logger.info('AppStore', 'Application initialized', {
      loggingEnabled,
      logLevel,
      timestamp: new Date().toISOString(),
    });

    return settingsStore.subscribe((state, previous) => {
      if (state.settings.advanced !== previous.settings.advanced) {
        const { loggingEnabled: enabled, logLevel: level } = state.settings.advanced;
        logger.setEnabled(enabled);
        logger.setMinLevel(level);
      }
    });
  }, []);

  useEffect(() => {
    let pendingCleanup: (() => void) | null = null;
    const unsubscribe = settingsStore.subscribe((state, previous) => {
      if (state.settings !== previous.settings || state.themeSettings !== previous.themeSettings) {
        pendingCleanup?.();
        pendingCleanup = persistSettings(state.settings, state.themeSettings);
      }
    });
    return () => {
      pendingCleanup?.();
      unsubscribe();
    };
  }, []);
}
