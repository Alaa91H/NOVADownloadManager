import { create } from 'zustand';
import type { AppSettings, AppThemeSettings } from '../types/desktop-ui.types';
import { initialSettings } from '../initialData';
import { tauriClient } from '../api/tauriClient';
import { LANGUAGE_METADATA } from '../lib/i18n/languageMetadata';
import { type Language } from '../lib/i18n/translations';
// uiStore is statically imported by appStore/queueStore/selectors/taskStore, so
// a dynamic import here could never split it into a separate chunk (Vite warns
// INEFFECTIVE_DYNAMIC_IMPORT). The static import is safe: settingsStore only
// touches uiStore inside updateSettings (runtime), never at module evaluation.
import { uiStore } from './uiStore';

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

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function sanitizeSettingsPatch(value: unknown, template: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !isPlainRecord(template)) return null;

  const patch: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!Object.hasOwn(template, key)) continue;
    const expected = template[key];
    if (Array.isArray(expected)) {
      if (!Array.isArray(candidate)) return null;
      patch[key] = candidate;
    } else if (isPlainRecord(expected)) {
      const nested = sanitizeSettingsPatch(candidate, expected);
      if (!nested) return null;
      patch[key] = nested;
    } else if (typeof candidate !== typeof expected) {
      return null;
    } else {
      patch[key] = candidate;
    }
  }
  return patch;
}

export function parseSettingsBackup(value: unknown): Partial<AppSettings> | null {
  return sanitizeSettingsPatch(value, initialSettings);
}

function mergeSettings(base: AppSettings, parsed: Partial<AppSettings>): AppSettings {
  const safe = parseSettingsBackup(parsed) ?? {};
  const parsedSave = safe.saveAndCategories;
  const safeSaveAndCategories: Partial<AppSettings['saveAndCategories']> = parsedSave ?? {};
  return ensureBrowserPairingToken({
    ...base,
    ...safe,
    general: {
      ...base.general,
      ...(safe.general || {}),
      integrateWithBrowsers: {
        ...base.general.integrateWithBrowsers,
        ...(safe.general?.integrateWithBrowsers || {}),
      },
    },
    fileTypes: {
      ...base.fileTypes,
      ...(safe.fileTypes || {}),
      extensions: { ...base.fileTypes.extensions, ...(safe.fileTypes?.extensions || {}) },
    },
    connection: {
      ...base.connection,
      ...(safe.connection || {}),
      speedLimiter: { ...base.connection.speedLimiter, ...(safe.connection?.speedLimiter || {}) },
      defaults: { ...base.connection.defaults, ...(safe.connection?.defaults || {}) },
    },
    saveAndCategories: {
      ...base.saveAndCategories,
      ...safeSaveAndCategories,
      categoryFolders: {
        ...base.saveAndCategories.categoryFolders,
        ...(safeSaveAndCategories.categoryFolders || {}),
      },
    },
    sounds: { ...base.sounds, ...(safe.sounds || {}) },
    ui: {
      ...base.ui,
      ...(safe.ui || {}),
      toolbar: { ...base.ui.toolbar, ...(safe.ui?.toolbar || {}) },
      statusBar: { ...base.ui.statusBar, ...(safe.ui?.statusBar || {}) },
      customButtons: safe.ui?.customButtons || base.ui.customButtons,
    },
    keyboardShortcuts: {
      ...base.keyboardShortcuts,
      ...(safe.keyboardShortcuts || {}),
      bindings: { ...base.keyboardShortcuts.bindings, ...(safe.keyboardShortcuts?.bindings || {}) },
    },
    advanced: { ...base.advanced, ...(safe.advanced || {}) },
    extra: {
      ...base.extra,
      ...(safe.extra || {}),
      language: safe.extra?.language || base.extra.language || detectSystemLanguage(),
    },
  });
}

export const mergeStoredSettings = (parsed: Partial<AppSettings>): AppSettings =>
  mergeSettings(initialSettings, parsed);

export const mergeSettingsPatch = (base: AppSettings, patch: Partial<AppSettings>): AppSettings =>
  mergeSettings(base, patch);

const initSettings = (): AppSettings => {
  const cached = localStorage.getItem('nova_settings_v1');
  if (cached) {
    try {
      return mergeStoredSettings(JSON.parse(cached) as Partial<AppSettings>);
    } catch {
      /* fall through */
    }
  }
  return ensureBrowserPairingToken({
    ...initialSettings,
    extra: { ...initialSettings.extra, language: detectSystemLanguage() },
  });
};

const initTheme = (): AppThemeSettings => {
  const cached = localStorage.getItem('nova_theme_settings_v1');
  const base = { theme: 'system', density: 'compact', accent: 'blue', progress: 'bar', contrast: 'normal' };
  if (cached) {
    try {
      return { ...base, ...(JSON.parse(cached) as AppThemeSettings) };
    } catch {
      /* keep defaults */
    }
  }
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

  _setSettings: (s) => {
    set({ settings: s });
  },
  _setThemeSettings: (t) => {
    set({ themeSettings: t });
  },
  incrementI18nRevision: () => {
    set((p) => ({ i18nRevision: p.i18nRevision + 1 }));
  },

  updateSettings: (updated, silent = false) => {
    const sanitized = mergeStoredSettings(updated);
    set({ settings: sanitized });
    void tauriClient.saveConfigToDisk(sanitized).then(
      (saved) => {
        if (silent) return;
        if (saved) {
          uiStore.getState().addToast('success', 'Settings Saved', 'Preferences and settings were saved.');
        } else {
          uiStore
            .getState()
            .addToast(
              'error',
              'Settings Not Saved',
              'Your changes are active for this session, but could not be saved to disk.',
            );
        }
      },
      () => {
        if (!silent) {
          uiStore
            .getState()
            .addToast(
              'error',
              'Settings Not Saved',
              'Your changes are active for this session, but could not be saved to disk.',
            );
        }
      },
    );
  },

  updateThemeSettings: (key, value) => {
    set((p) => ({ themeSettings: { ...p.themeSettings, [key]: value } }));
  },
}));

export async function restoreSettingsFromDisk(): Promise<{ warnings: string[]; error?: string }> {
  const loaded = await tauriClient.loadConfigFromDisk();
  if (loaded.settings) {
    settingsStore.getState()._setSettings(mergeStoredSettings(loaded.settings));
  }
  return { warnings: loaded.warnings, error: loaded.error };
}
