/* src/dialogs/settings/sections/AppearanceSettings.tsx */
import React from 'react';
import type { AppSettings, AppThemeSettings } from '../../../types/desktop-ui.types';
import { SelectField } from '../../../components/primitives';
import { Settings, Palette } from 'lucide-react';
import { useI18n } from '../../../store/selectors';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  themeSettings: AppThemeSettings;
  onUpdateThemeSettings: (key: keyof AppThemeSettings, value: string) => void;
}

export const AppearanceSettings: React.FC<Props> = ({ themeSettings, onUpdateThemeSettings }) => {
  const t = useI18n();
  const themes: Array<{ value: AppThemeSettings['theme']; label: string; icon: string }> = [
    { value: 'dark', label: t('theme_dark'), icon: '\u{1F319}' },
    { value: 'light', label: t('theme_light'), icon: '\u{2600}\u{FE0F}' },
    { value: 'system', label: t('theme_system'), icon: '\u{1F4BB}' },
    { value: 'midnight', label: t('theme_midnight'), icon: '\u{1F311}' },
    { value: 'graphite', label: t('theme_graphite'), icon: '\u{26CF}\u{FE0F}' },
    { value: 'nord', label: t('theme_nord'), icon: '\u{2744}\u{FE0F}' },
    { value: 'solar', label: t('theme_solar'), icon: '\u{1F305}' },
  ];

  const accentColors: Array<{ value: AppThemeSettings['accent']; label: string; color: string }> = [
    { value: 'blue', label: t('settings_blue'), color: '#3b82f6' },
    { value: 'emerald', label: t('settings_emerald'), color: '#10b981' },
    { value: 'amber', label: t('settings_amber'), color: '#f59e0b' },
    { value: 'crimson', label: t('settings_crimson'), color: '#dc2626' },
    { value: 'violet', label: t('settings_violet'), color: '#8b5cf6' },
  ];

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      {/* ── Theme ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Settings className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">{t('settings_theme_preset')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="grid grid-cols-1 gap-3">
            {themes.map((theme) => (
              <button
                key={theme.value}
                type="button"
                onClick={() => {
                  onUpdateThemeSettings('theme', theme.value);
                }}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all cursor-pointer text-left ${
                  themeSettings.theme === theme.value
                    ? 'bg-[var(--accent-primary)]/10 border-[var(--accent-primary)]/40 text-[var(--accent-primary)]'
                    : 'bg-[var(--bg-hover)]/20 border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]/40'
                }`}
              >
                <span className="text-base">{theme.icon}</span>
                <span className="text-xs font-bold">{theme.label}</span>
                {themeSettings.theme === theme.value && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-[var(--accent-primary)]" />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Density & Accent ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Palette className="w-4 h-4 text-[var(--success)]" />
          <h3 className="text-sm font-extrabold text-[var(--success)]">{t('settings_appearance')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <SelectField
            label={t('settings_interface_density')}
            value={themeSettings.density}
            onChange={(e) => {
              onUpdateThemeSettings('density', e.target.value);
            }}
            options={[
              { value: 'compact', label: t('settings_density_compact') },
              { value: 'normal', label: t('settings_density_comfortable') },
              { value: 'dense', label: t('settings_density_dense') },
            ]}
          />

          <SelectField
            label={t('settings_accent_color')}
            value={themeSettings.accent}
            onChange={(e) => {
              onUpdateThemeSettings('accent', e.target.value);
            }}
            options={accentColors.map((c) => ({
              value: c.value,
              label: `${c.label}  `,
            }))}
          />
          <div className="flex gap-2 -mt-1">
            {accentColors.map((c) => (
              <button
                key={c.value}
                type="button"
                title={c.label}
                onClick={() => {
                  onUpdateThemeSettings('accent', c.value);
                }}
                className={`w-5 h-5 rounded-full border-2 transition-all cursor-pointer ${
                  themeSettings.accent === c.value
                    ? 'border-[var(--text-primary)] scale-125'
                    : 'border-transparent hover:border-[var(--border-color)]'
                }`}
                style={{ backgroundColor: c.color }}
              />
            ))}
          </div>

          <SelectField
            label={t('settings_progress_display')}
            value={themeSettings.progress}
            onChange={(e) => {
              onUpdateThemeSettings('progress', e.target.value);
            }}
            options={[
              { value: 'bar', label: t('settings_progress_bar') },
              { value: 'circle', label: t('settings_progress_ring') },
              { value: 'percentage', label: t('settings_progress_percentage') },
            ]}
          />

          <SelectField
            label={t('set_theme_contrast')}
            value={themeSettings.contrast}
            onChange={(e) => {
              onUpdateThemeSettings('contrast', e.target.value);
            }}
            options={[
              { value: 'normal', label: t('set_theme_contrast_normal') },
              { value: 'high', label: t('set_theme_contrast_high') },
            ]}
          />
        </div>
      </div>
    </div>
  );
};
