/* src/dialogs/settings/sections/AppearanceAndSecurity.tsx */
import React from 'react';
import { AppThemeSettings, AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, SelectField, Checkbox } from '../../../components/primitives';
import { Palette, Shield } from 'lucide-react';
import { useAppStore } from '../../../state/appStore';

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
  const { t } = useAppStore();

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Palette className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">{t('settings_appearance')}</h3>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div className="space-y-1.5">
            <span className="text-xs font-semibold text-[var(--text-secondary)]">{t('settings_accent_color')}</span>
            <div className="flex gap-2.5 pt-1">
              {[
                { id: 'blue', color: 'bg-blue-500', label: t('settings_blue') },
                { id: 'emerald', color: 'bg-emerald-500', label: t('settings_emerald') },
                { id: 'amber', color: 'bg-amber-500', label: t('settings_amber') },
                { id: 'crimson', color: 'bg-rose-500', label: t('settings_crimson') },
                { id: 'violet', color: 'bg-purple-500', label: t('settings_violet') },
              ].map((acc) => (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => {
                    updateThemeSetting('accent', acc.id);
                  }}
                  className={`w-6 h-6 rounded-full ${acc.color} cursor-pointer transition-all ${themeSettings.accent === acc.id ? 'ring-2 ring-offset-2 ring-slate-100 scale-110 shadow-lg' : 'opacity-70 hover:opacity-100'}`}
                  title={acc.label}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1 mb-1">
            {t('settings_layout')}
          </span>
          <FormRow label={t('settings_sidebar_expanded')}>
            <Switch
              checked={themeSettings.sidebar === 'expanded'}
              onChange={(checked) => {
                updateThemeSetting('sidebar', checked ? 'expanded' : 'collapsed');
              }}
            />
          </FormRow>
          <FormRow label={t('settings_blur_glass')}>
            <Switch
              checked={themeSettings.blur === 'enabled'}
              onChange={(checked) => {
                updateThemeSetting('blur', checked ? 'enabled' : 'disabled');
              }}
            />
          </FormRow>
          <FormRow label={t('settings_reduced_motion')}>
            <Switch
              checked={themeSettings.motion === 'reduced'}
              onChange={(checked) => {
                updateThemeSetting('motion', checked ? 'reduced' : 'enabled');
              }}
            />
          </FormRow>
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

      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Shield className="w-4 h-4 text-emerald-500" />
          <h3 className="text-sm font-extrabold text-emerald-400">{t('settings_security_privacy')}</h3>
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
            <label className="text-[11px] text-slate-400 font-bold block">{t('settings_trusted_origins')}</label>
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
