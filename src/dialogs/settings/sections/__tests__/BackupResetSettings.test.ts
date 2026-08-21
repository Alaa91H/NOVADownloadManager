import { describe, expect, it } from 'vitest';
import { initialSettings } from '../../../../initialData';
import { sanitizeSettingsBackup } from '../BackupResetSettings';

describe('sanitizeSettingsBackup', () => {
  it('excludes credentials and browser pairing material while preserving preferences', () => {
    const settings = {
      ...initialSettings,
      general: { ...initialSettings.general, monitorClipboard: false },
      connection: { ...initialSettings.connection, proxyUser: 'proxy-user', proxyPass: 'proxy-password' },
      extra: {
        ...initialSettings.extra,
        tgBotToken: 'telegram-token',
        browserPairingToken: 'nova_token_secret',
        language: 'fr',
      },
    };

    const backup = sanitizeSettingsBackup(settings);

    expect(backup.connection.proxyUser).toBe('');
    expect(backup.connection.proxyPass).toBe('');
    expect(backup.extra.tgBotToken).toBe('');
    expect(backup.extra.browserPairingToken).toBe('');
    expect(backup.extra.language).toBe('fr');
    expect(backup.general.monitorClipboard).toBe(false);
    expect(settings.connection.proxyPass).toBe('proxy-password');
  });
});
