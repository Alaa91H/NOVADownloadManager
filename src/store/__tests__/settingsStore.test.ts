import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  settingsStore,
  mergeSettingsPatch,
  mergeStoredSettings,
  parseSettingsBackup,
  restoreSettingsFromDisk,
} from '../settingsStore';
import { initialSettings } from '../../initialData';
import { tauriClient } from '../../api/tauriClient';
import type { AppSettings, AppThemeSettings } from '../../types/desktop-ui.types';

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock('../../api/tauriClient', () => ({
  tauriClient: {
    saveConfigToDisk: vi.fn().mockResolvedValue(undefined),
    loadConfigFromDisk: vi.fn().mockResolvedValue({ settings: null, warnings: [] }),
    openDownloadedFile: vi.fn().mockResolvedValue(true),
    revealDownloadedFile: vi.fn().mockResolvedValue(true),
    getSystemInfo: vi.fn().mockResolvedValue({ os: 'Windows', arch: 'x86_64' }),
  },
}));
vi.mock('../../utils/sound', () => ({ playAppSound: vi.fn() }));
vi.mock('../uiStore', () => ({
  uiStore: {
    getState: () => ({ addToast }),
  },
}));

describe('mergeStoredSettings', () => {
  it('merges partial settings with initial defaults', () => {
    const partial: Partial<AppSettings> = { general: { ...initialSettings.general, monitorClipboard: true } };
    const merged = mergeStoredSettings(partial);
    expect(merged.general.monitorClipboard).toBe(true);
    expect(merged.saveAndCategories).toBeDefined();
    expect(merged.connection).toBeDefined();
  });

  it('preserves existing values when merging', () => {
    const partial: Partial<AppSettings> = {
      general: { ...initialSettings.general, monitorClipboard: true },
      saveAndCategories: { ...initialSettings.saveAndCategories, defaultFolder: '/custom/path' },
    };
    const merged = mergeStoredSettings(partial);
    expect(merged.general.monitorClipboard).toBe(true);
    expect(merged.saveAndCategories.defaultFolder).toBe('/custom/path');
  });

  it('ensures browserPairingToken is generated if missing', () => {
    const merged = mergeStoredSettings({ extra: { ...initialSettings.extra, browserPairingToken: '' } });
    expect(merged.extra.browserPairingToken).toMatch(/^nova_token_/);
  });

  it('preserves existing browserPairingToken', () => {
    const merged = mergeStoredSettings({ extra: { ...initialSettings.extra, browserPairingToken: 'existing_token' } });
    expect(merged.extra.browserPairingToken).toBe('existing_token');
  });

  it('returns full initialSettings when empty object provided', () => {
    const merged = mergeStoredSettings({});
    expect(merged.general).toEqual(initialSettings.general);
    expect(merged.connection).toEqual(initialSettings.connection);
  });

  it('rejects malformed backups and removes unknown fields', () => {
    expect(parseSettingsBackup({ general: { monitorClipboard: 'yes' } })).toBeNull();
    expect(parseSettingsBackup(['not', 'an', 'object'])).toBeNull();
    expect(parseSettingsBackup({ futureOption: true })).toEqual({});
  });

  it('applies a partial backup without resetting untouched nested preferences', () => {
    const base = {
      ...initialSettings,
      general: { ...initialSettings.general, checkUpdates: true },
      connection: {
        ...initialSettings.connection,
        defaults: { ...initialSettings.connection.defaults, retryCount: 9 },
      },
    };
    const partialBackup = {
      general: { monitorClipboard: false },
      connection: { defaults: { timeoutSec: 120 } },
    } as unknown as Partial<AppSettings>;
    const merged = mergeSettingsPatch(base, partialBackup);

    expect(merged.general.monitorClipboard).toBe(false);
    expect(merged.general.checkUpdates).toBe(true);
    expect(merged.connection.defaults.timeoutSec).toBe(120);
    expect(merged.connection.defaults.retryCount).toBe(9);
  });
});

describe('settingsStore', () => {
  beforeEach(() => {
    vi.mocked(tauriClient).saveConfigToDisk.mockResolvedValue(true);
    vi.mocked(tauriClient).loadConfigFromDisk.mockResolvedValue({ settings: null, warnings: [] });
    addToast.mockReset();
    settingsStore.setState({
      settings: { ...initialSettings, extra: { ...initialSettings.extra, browserPairingToken: 'test_token_abc' } },
      themeSettings: { theme: 'system', density: 'compact', accent: 'blue', progress: 'bar', contrast: 'normal' },
      i18nRevision: 0,
    });
  });

  it('restores persisted settings before the application mounts', async () => {
    vi.mocked(tauriClient).loadConfigFromDisk.mockResolvedValue({
      settings: { general: { ...initialSettings.general, monitorClipboard: true } },
      warnings: ['A legacy credential was cleared.'],
    });

    const result = await restoreSettingsFromDisk();

    expect(settingsStore.getState().settings.general.monitorClipboard).toBe(true);
    expect(settingsStore.getState().settings.connection).toEqual(initialSettings.connection);
    expect(result).toEqual({ warnings: ['A legacy credential was cleared.'], error: undefined });
  });

  it('has correct initial state shape', () => {
    const s = settingsStore.getState();
    expect(s.settings).toBeDefined();
    expect(s.themeSettings).toBeDefined();
    expect(s.i18nRevision).toBe(0);
  });

  it('updateSettings merges and persists', () => {
    const updated = {
      ...settingsStore.getState().settings,
      general: { ...settingsStore.getState().settings.general, monitorClipboard: true },
    };
    settingsStore.getState().updateSettings(updated, true);
    expect(settingsStore.getState().settings.general.monitorClipboard).toBe(true);
  });

  it('reports a persistence failure instead of a false save confirmation', async () => {
    vi.mocked(tauriClient).saveConfigToDisk.mockResolvedValue(false);
    const updated = {
      ...settingsStore.getState().settings,
      general: { ...settingsStore.getState().settings.general, monitorClipboard: true },
    };

    settingsStore.getState().updateSettings(updated);

    await vi.waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        'error',
        'Settings Not Saved',
        'Your changes are active for this session, but could not be saved to disk.',
      );
    });
    expect(addToast).not.toHaveBeenCalledWith('success', 'Settings Saved', expect.any(String));
  });

  it('updateThemeSettings updates a single key', () => {
    settingsStore.getState().updateThemeSettings('accent', 'red');
    expect(settingsStore.getState().themeSettings.accent).toBe('red');
  });

  it('incrementI18nRevision increments counter', () => {
    expect(settingsStore.getState().i18nRevision).toBe(0);
    settingsStore.getState().incrementI18nRevision();
    expect(settingsStore.getState().i18nRevision).toBe(1);
    settingsStore.getState().incrementI18nRevision();
    expect(settingsStore.getState().i18nRevision).toBe(2);
  });

  it('_setSettings replaces settings wholesale', () => {
    const newSettings = { ...initialSettings, general: { ...initialSettings.general, monitorClipboard: true } };
    settingsStore.getState()._setSettings(newSettings);
    expect(settingsStore.getState().settings.general.monitorClipboard).toBe(true);
  });

  it('_setThemeSettings replaces theme wholesale', () => {
    const newTheme = { theme: 'dark', density: 'comfortable', accent: 'green', progress: 'ring', contrast: 'high' };
    settingsStore.getState()._setThemeSettings(newTheme as AppThemeSettings);
    expect(settingsStore.getState().themeSettings).toEqual(newTheme);
  });
});
