import { create } from 'zustand';
import type { AppSettings, AppThemeSettings } from '../types/desktop-ui.types';
import { initialSettings } from '../initialData';
import { tauriClient } from '../api/tauriClient';
import { LANGUAGE_METADATA } from '../lib/i18n/languageMetadata';
import { type Language } from '../lib/i18n/translations';

const supportedLanguages = new Set<string>(LANGUAGE_METADATA.map((l) => l.value));
const normalizeLanguageTag = (v: string) => v.trim().replace(/_/g, '-');
const systemLanguageCandidates = (): string[] => {
  if (typeof navigator === 'undefined') return [];
  const langs = navigator.languages.length ? navigator.languages : [navigator.language];
  return langs.filter((l): l is string => typeof l === 'string' && l.trim().length > 0);
};
const languageFallbacks = (lang: string): string[] => {
  const n = normalizeLanguageTag(lang).toLowerCase();
  const base = n.split('-')[0];
  const c = [n, n.toLowerCase(), base];
  if (base === 'zh') {
    if (n.includes('tw') || n.includes('hk') || n.includes('mo') || n.includes('hant')) c.unshift('zh-TW');
    else c.unshift('zh');
  }
  return c;
};
const detectSystemLanguage = (): Language => {
  for (const lang of systemLanguageCandidates()) {
    for (const c of languageFallbacks(lang)) {
      if (supportedLanguages.has(c)) return c as Language;
    }
  }
  return 'en';
};

const generateBrowserPairingToken = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `nova_token_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};
const ensureBrowserPairingToken = (s: AppSettings): AppSettings => {
  if (s.extra.browserPairingToken) return s;
  return { ...s, extra: { ...s.extra, browserPairingToken: generateBrowserPairingToken() } };
};

export const mergeStoredSettings = (parsed: Partial<AppSettings>): AppSettings => {
  const parsedSave = parsed.saveAndCategories;
  const safeSaveAndCategories: Partial<AppSettings['saveAndCategories']> = parsedSave ?? {};
  return ensureBrowserPairingToken({
    ...initialSettings,
    ...parsed,
    general: { ...initialSettings.general, ...(parsed.general || {}), integrateWithBrowsers: { ...initialSettings.general.integrateWithBrowsers, ...(parsed.general?.integrateWithBrowsers || {}) } },
    connection: { ...initialSettings.connection, ...(parsed.connection || {}), speedLimiter: { ...initialSettings.connection.speedLimiter, ...(parsed.connection?.speedLimiter || {}) }, defaults: { ...initialSettings.connection.defaults, ...(parsed.connection?.defaults || {}) } },
    saveAndCategories: { ...initialSettings.saveAndCategories, ...safeSaveAndCategories, categoryFolders: { ...initialSettings.saveAndCategories.categoryFolders, ...(safeSaveAndCategories.categoryFolders || {}) } },
    sounds: { ...initialSettings.sounds, ...(parsed.sounds || {}) },
    ui: { ...initialSettings.ui, ...(parsed.ui || {}), toolbar: { ...initialSettings.ui.toolbar, ...(parsed.ui?.toolbar || {}) }, statusBar: { ...initialSettings.ui.statusBar, ...(parsed.ui?.statusBar || {}) }, customButtons: parsed.ui?.customButtons || initialSettings.ui.customButtons },
    keyboardShortcuts: { ...initialSettings.keyboardShortcuts, ...(parsed.keyboardShortcuts || {}), bindings: { ...initialSettings.keyboardShortcuts.bindings, ...(parsed.keyboardShortcuts?.bindings || {}) } },
    advanced: { ...initialSettings.advanced, ...(parsed.advanced || {}) },
    extra: { ...initialSettings.extra, ...(parsed.extra || {}), language: parsed.extra?.language || detectSystemLanguage() },
  });
};

const initSettings = (): AppSettings => {
  const cached = localStorage.getItem('nova_settings_v1');
  if (cached) {
    try { return mergeStoredSettings(JSON.parse(cached) as Partial<AppSettings>); } catch { /* fall through */ }
  }
  return ensureBrowserPairingToken({ ...initialSettings, extra: { ...initialSettings.extra, language: detectSystemLanguage() } });
};

const initTheme = (): AppThemeSettings => {
  const cached = localStorage.getItem('nova_theme_settings_v1');
  const base = { theme: 'system', density: 'compact', accent: 'blue', progress: 'bar', contrast: 'normal' };
  if (cached) { try { return { ...base, ...(JSON.parse(cached) as AppThemeSettings) }; } catch { /* keep defaults */ } }
  return base as AppThemeSettings;
};

interface SettingsState {
  settings: AppSettings;
  themeSettings: AppThemeSettings;
  i18nRevision: number;
  updateSettings: (updated: AppSettings, silent?: boolean) => void;
  updateThemeSettings: (key: keyof AppThemeSettings, value: string) => void;
  _setSettings: (s: AppSettings) => void;
  _setThemeSettings: (t: AppThemeSettings) => void;
  incrementI18nRevision: () => void;
}

export const settingsStore = create<SettingsState>()((set) => ({
  settings: initSettings(),
  themeSettings: initTheme(),
  i18nRevision: 0,

  _setSettings: (s) => { set({ settings: s }); },
  _setThemeSettings: (t) => { set({ themeSettings: t }); },
  incrementI18nRevision: () => { set((p) => ({ i18nRevision: p.i18nRevision + 1 })); },

  updateSettings: (updated, silent = false) => {
    const sanitized = mergeStoredSettings(updated);
    set({ settings: sanitized });
    void tauriClient.saveConfigToDisk(sanitized);
    if (!silent) {
      void import('./uiStore').then(({ uiStore }) => {
        uiStore.getState().addToast('success', 'Settings Saved', 'Preferences and settings were saved.');
      });
    }
  },

  updateThemeSettings: (key, value) => { set((p) => ({ themeSettings: { ...p.themeSettings, [key]: value } })); },
}));
