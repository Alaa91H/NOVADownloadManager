import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sections/GeneralSettings', () => ({ GeneralSettings: () => <div data-testid="settings-panel" /> }));
vi.mock('../sections/DownloadSettings', () => ({ DownloadSettings: () => <div data-testid="settings-panel" /> }));
vi.mock('../sections/NetworkAndPerformance', () => ({
  NetworkAndPerformance: () => <div data-testid="settings-panel" />,
}));
vi.mock('../sections/AppearanceSettings', () => ({ AppearanceSettings: () => <div data-testid="settings-panel" /> }));
vi.mock('../sections/BrowserSettings', () => ({ BrowserSettings: () => <div data-testid="settings-panel" /> }));
vi.mock('../sections/MediaSettings', () => ({ MediaSettings: () => <div data-testid="settings-panel" /> }));
vi.mock('../sections/TelegramBotSettings', () => ({ TelegramBotSettings: () => <div data-testid="settings-panel" /> }));
vi.mock('../sections/ExternalToolsSettings', () => ({
  ExternalToolsSettings: () => <div data-testid="settings-panel" />,
}));
vi.mock('../sections/LoggingSettings', () => ({ LoggingSettings: () => <div data-testid="settings-panel" /> }));
vi.mock('../sections/BackupResetSettings', () => ({ BackupResetSettings: () => <div data-testid="settings-panel" /> }));

import { SettingsDialog } from '../SettingsDialog';
import { initialSettings } from '../../../initialData';
import { loadLanguage } from '../../../lib/i18n/translations';
import { settingsStore } from '../../../store/settingsStore';
import { uiStore } from '../../../store/uiStore';

describe('SettingsDialog navigation localization', () => {
  beforeEach(async () => {
    await loadLanguage('ar');
    settingsStore.setState({
      settings: {
        ...structuredClone(initialSettings),
        extra: { ...initialSettings.extra, language: 'ar' },
      },
    });
    uiStore.setState({ dialog: { active: 'settings', payload: {} } });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders every settings navigation tab in Arabic', () => {
    render(<SettingsDialog />);

    for (const label of [
      'عام وتنزيلات',
      'جميع التنزيلات',
      'الشبكة والأداء',
      'المظهر',
      'المتصفح المدمج',
      'الوسائط',
      'بوت التليجرام',
      'محركات التحميل',
      'سجل التطبيق',
      'النسخ الاحتياطي والاستعادة',
    ]) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }

    expect(screen.queryByRole('tab', { name: 'External Tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Backup & Reset' })).not.toBeInTheDocument();
  });
});
