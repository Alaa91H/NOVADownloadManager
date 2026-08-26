/* src/dialogs/settings/sections/BrowserSettings.tsx */
import React from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { Switch, SelectField } from '../../../components/primitives';
import { Globe, Keyboard } from 'lucide-react';
import { useI18n } from '../../../store/selectors';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
}

export const BrowserSettings: React.FC<Props> = ({ settings, updateSetting }) => {
  const t = useI18n();
  const browsers: Array<{ key: 'chrome' | 'edge' | 'firefox' | 'safari'; label: string }> = [
    { key: 'chrome', label: t('settings_browser_chrome') },
    { key: 'edge', label: t('settings_browser_edge') },
    { key: 'firefox', label: t('settings_browser_firefox') },
    { key: 'safari', label: t('settings_browser_safari') },
  ];

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      {/* ── Browser Integration ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Globe className="w-4 h-4 text-[var(--info)]" />
          <h3 className="text-sm font-extrabold text-[var(--info)]">{t('settings_browser_integration')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          {browsers.map((browser) => (
            <div key={browser.key} className="flex items-center justify-between py-2">
              <span className="text-xs font-bold text-[var(--text-primary)]">{browser.label}</span>
              <Switch
                checked={settings.general.integrateWithBrowsers[browser.key]}
                onChange={(v) => {
                  updateSetting('general', 'integrateWithBrowsers', {
                    ...settings.general.integrateWithBrowsers,
                    [browser.key]: v,
                  });
                }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* ── Monitoring ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Keyboard className="w-4 h-4 text-[var(--warning)]" />
          <h3 className="text-sm font-extrabold text-[var(--warning)]">{t('settings_monitor_clipboard')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex items-center justify-between py-2">
            <span className="text-xs font-bold text-[var(--text-primary)]">{t('settings_monitor_clipboard')}</span>
            <Switch
              checked={settings.general.monitorClipboard}
              onChange={(v) => {
                updateSetting('general', 'monitorClipboard', v);
              }}
            />
          </div>
        </div>
      </div>

      {/* ── Intercept Keys ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Keyboard className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">
            {t('settings_browser_intercept_keys')}
          </h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <SelectField
            label={t('settings_browser_intercept_keys')}
            value={settings.advanced.browserInterceptKeys}
            onChange={(e) => {
              updateSetting('advanced', 'browserInterceptKeys', e.target.value);
            }}
            options={[
              { value: 'Alt', label: t('settings_intercept_alt') },
              { value: 'Ctrl', label: t('settings_intercept_ctrl') },
              { value: 'Shift', label: t('settings_intercept_shift') },
              { value: 'Alt+Ctrl', label: t('settings_intercept_alt_ctrl') },
            ]}
          />
        </div>
      </div>
    </div>
  );
};
