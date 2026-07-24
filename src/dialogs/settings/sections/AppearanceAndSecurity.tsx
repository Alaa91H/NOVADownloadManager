/* src/dialogs/settings/sections/AppearanceAndSecurity.tsx */
import React from 'react';
import type { AppThemeSettings, AppSettings, AppTheme } from '../../../types/desktop-ui.types';
import { SelectField, Checkbox } from '../../../components/primitives';
import { Palette, Shield, Check, Monitor } from 'lucide-react';
import { useI18n } from '../../../store/selectors';
import { InterfaceCustomization } from './InterfaceCustomization';

// Swatch colors give a faithful mini-preview of each theme without applying it.
const THEME_PRESETS: { id: AppTheme; labelKey: string; swatches: [string, string, string]; isSystem?: boolean }[] = [
  { id: 'dark', labelKey: 'theme_dark', swatches: ['#050507', '#1c1c21', '#3b82f6'] },
  { id: 'midnight', labelKey: 'theme_midnight', swatches: ['#060a14', '#121b30', '#608def'] },
  { id: 'graphite', labelKey: 'theme_graphite', swatches: ['#121212', '#262626', '#b3b3b3'] },
  { id: 'nord', labelKey: 'theme_nord', swatches: ['#242933', '#434c5e', '#88c0d0'] },
  { id: 'light', labelKey: 'theme_light', swatches: ['#f1f5f9', '#ffffff', '#3b82f6'] },
  { id: 'solar', labelKey: 'theme_solar', swatches: ['#f7f2e7', '#fdfaf3', '#b58900'] },
  { id: 'system', labelKey: 'theme_system', swatches: ['#050507', '#f1f5f9', '#3b82f6'], isSystem: true },
];

interface Props {
  settings: AppSettings;
  themeSettings: AppThemeSettings;
  updateThemeSetting: (key: keyof AppThemeSettings, value: unknown) => void;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
}

export const AppearanceAndSecurity: React.FC<Props> = ({
  settings,
  themeSettings,
  updateThemeSetting,
  updateSetting,
}) => {
  const t = useI18n();

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Palette className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">{t('settings_appearance')}</h3>
        </div>

        {/* Theme presets */}
        <div className="space-y-1.5">
          <span className="text-xs font-semibold text-[var(--text-secondary)]">{t('settings_theme_preset')}</span>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 pt-1">
            {THEME_PRESETS.map((preset) => {
              const isActive = themeSettings.theme === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    updateThemeSetting('theme', preset.id);
                  }}
                  className={`relative flex flex-col gap-2 p-2.5 rounded-lg border text-left cursor-pointer transition-all duration-150 hover:scale-[1.02] active:scale-[0.98] ${
                    isActive
                      ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 shadow-sm'
                      : 'border-[var(--border-color)] hover:border-[var(--border-color-hover)] hover:bg-[var(--bg-hover)]'
                  }`}
                  title={t(preset.labelKey)}
                >
                  <div className="flex items-center gap-1">
                    {preset.isSystem ? (
                      <span className="w-8 h-5 rounded border border-[var(--border-color)] flex items-center justify-center bg-[var(--bg-input)]">
                        <Monitor className="w-3 h-3 text-[var(--text-secondary)]" />
                      </span>
                    ) : (
                      preset.swatches.map((color, i) => (
                        <span
                          key={i}
                          className="w-5 h-5 rounded border border-black/20"
                          style={{ backgroundColor: color }}
                        />
                      ))
                    )}
                  </div>
                  <span
                    className={`text-[11px] font-bold ${isActive ? 'text-[var(--accent-primary)]' : 'text-[var(--text-secondary)]'}`}
                  >
                    {t(preset.labelKey)}
                  </span>
                  {isActive && (
                    <Check className="absolute top-1.5 right-1.5 w-3.5 h-3.5 text-[var(--accent-primary)]" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div className="space-y-1.5">
            <span className="text-xs font-semibold text-[var(--text-secondary)]">{t('settings_accent_color')}</span>
            <div className="flex gap-2.5 pt-1">
              {[
                { id: 'blue', color: 'bg-[var(--info)]', label: t('settings_blue') },
                { id: 'emerald', color: 'bg-[var(--success)]', label: t('settings_emerald') },
                { id: 'amber', color: 'bg-[var(--warning)]', label: t('settings_amber') },
                { id: 'crimson', color: 'bg-[var(--danger)]', label: t('settings_crimson') },
                { id: 'violet', color: 'bg-[var(--accent-primary)]', label: t('settings_violet') },
              ].map((acc) => (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => {
                    updateThemeSetting('accent', acc.id);
                  }}
                  className={`w-6 h-6 rounded-full ${acc.color} cursor-pointer transition-all ${themeSettings.accent === acc.id ? 'ring-2 ring-offset-2 ring-[var(--text-primary)] scale-110 shadow-lg' : 'opacity-70 hover:opacity-100'}`}
                  title={acc.label}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <SelectField
            label={t('settings_interface_density')}
            value={themeSettings.density}
            onChange={(e) => {
              updateThemeSetting('density', e.target.value);
            }}
            options={[
              { value: 'compact', label: t('settings_density_compact') },
              { value: 'dense', label: t('settings_density_dense') },
              { value: 'normal', label: t('settings_density_comfortable') },
            ]}
          />

          <SelectField
            label={t('settings_progress_display')}
            value={themeSettings.progress}
            onChange={(e) => {
              updateThemeSetting('progress', e.target.value);
            }}
            options={[
              { value: 'bar', label: t('settings_progress_bar') },
              { value: 'circle', label: t('settings_progress_ring') },
              { value: 'percentage', label: t('settings_progress_percentage') },
            ]}
          />
        </div>
      </div>

      <InterfaceCustomization settings={settings} updateSetting={updateSetting} />

      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Shield className="w-4 h-4 text-[var(--success)]" />
          <h3 className="text-sm font-extrabold text-[var(--success)]">{t('settings_security_privacy')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1 mb-1">
            {t('settings_secrets_tokens')}
          </span>
          <div className="flex flex-col gap-2 pt-1">
            <Checkbox
              label={t('settings_encrypt_tokens')}
              checked={settings.extra.encryptAccessTokens}
              onChange={(v) => {
                updateSetting('extra', 'encryptAccessTokens', v);
              }}
            />
            <Checkbox
              label={t('settings_redact_credentials')}
              checked={settings.extra.redactTokens}
              onChange={(v) => {
                updateSetting('extra', 'redactTokens', v);
              }}
            />
            <Checkbox
              label={t('settings_prevent_clipboard')}
              checked={settings.extra.preventClipboardHistory}
              onChange={(v) => {
                updateSetting('extra', 'preventClipboardHistory', v);
              }}
            />
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1 mb-1">
            {t('settings_local_security')}
          </span>
          <div className="flex flex-col gap-2 pt-1">
            <Checkbox
              label={t('settings_bind_localhost')}
              checked={settings.extra.bindLocalhostOnly}
              onChange={(v) => {
                updateSetting('extra', 'bindLocalhostOnly', v);
              }}
            />
            <Checkbox
              label={t('settings_reject_external')}
              checked={settings.extra.rejectExternalRequests}
              onChange={(v) => {
                updateSetting('extra', 'rejectExternalRequests', v);
              }}
            />
          </div>

          <div className="space-y-1 pt-2">
            <label className="text-[11px] text-[var(--text-muted)] font-bold block">
              {t('settings_trusted_origins')}
            </label>
            <input
              type="text"
              value={settings.extra.trustedOrigins}
              onChange={(e) => {
                updateSetting('extra', 'trustedOrigins', e.target.value);
              }}
              className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded p-2 text-xs font-mono text-left"
              style={{ direction: 'ltr' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
