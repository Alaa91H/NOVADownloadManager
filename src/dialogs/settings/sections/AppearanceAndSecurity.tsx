/* src/dialogs/settings/sections/AppearanceAndSecurity.tsx */
import React from 'react';
import { AppThemeSettings, AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, SelectField, Checkbox } from '../../../components/primitives';
import { Palette, Shield } from 'lucide-react';

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
  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Palette className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">Appearance</h3>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div className="space-y-1.5">
            <span className="text-xs font-semibold text-[var(--text-secondary)]">Accent Color</span>
            <div className="flex gap-2.5 pt-1">
              {[
                { id: 'blue', color: 'bg-blue-500', label: 'Blue' },
                { id: 'emerald', color: 'bg-emerald-500', label: 'Emerald' },
                { id: 'amber', color: 'bg-amber-500', label: 'Amber' },
                { id: 'crimson', color: 'bg-rose-500', label: 'Crimson' },
                { id: 'violet', color: 'bg-purple-500', label: 'Violet' },
              ].map(acc => (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => updateThemeSetting('accent', acc.id as AppThemeSettings['accent'])}
                  className={`w-6 h-6 rounded-full ${acc.color} cursor-pointer transition-all ${themeSettings.accent === acc.id ? 'ring-2 ring-offset-2 ring-slate-100 scale-110 shadow-lg' : 'opacity-70 hover:opacity-100'}`}
                  title={acc.label}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1 mb-1">Layout</span>
          <FormRow label="Expanded sidebar">
            <Switch checked={themeSettings.sidebar === 'expanded'} onChange={(checked) => updateThemeSetting('sidebar', checked ? 'expanded' : 'collapsed')} />
          </FormRow>
          <FormRow label="Blur and glass effects">
            <Switch checked={themeSettings.blur === 'enabled'} onChange={(checked) => updateThemeSetting('blur', checked ? 'enabled' : 'disabled')} />
          </FormRow>
          <FormRow label="Reduced motion">
            <Switch checked={themeSettings.motion === 'reduced'} onChange={(checked) => updateThemeSetting('motion', checked ? 'reduced' : 'enabled')} />
          </FormRow>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <SelectField
            label="Interface Density"
            value={themeSettings.density}
            onChange={(e) => updateThemeSetting('density', e.target.value as AppThemeSettings['density'])}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'dense', label: 'Dense' },
              { value: 'normal', label: 'Comfortable' },
            ]}
          />

          <SelectField
            label="Progress Display"
            value={themeSettings.progress}
            onChange={(e) => updateThemeSetting('progress', e.target.value as AppThemeSettings['progress'])}
            options={[
              { value: 'bar', label: 'Progress Bar' },
              { value: 'circle', label: 'Ring Indicator' },
              { value: 'percentage', label: 'Percentage Only' },
            ]}
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Shield className="w-4 h-4 text-emerald-500" />
          <h3 className="text-sm font-extrabold text-emerald-400">Security & Privacy</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1 mb-1">Secrets & Tokens</span>
          <div className="flex flex-col gap-2 pt-1">
            <Checkbox label="Encrypt locally stored access tokens" checked={settings.extra.encryptAccessTokens} onChange={(v) => updateSetting('extra', 'encryptAccessTokens', v)} />
            <Checkbox label="Redact Telegram, webhook, and server credentials in the UI" checked={settings.extra.redactTokens} onChange={(v) => updateSetting('extra', 'redactTokens', v)} />
            <Checkbox label="Prevent sensitive links from remaining in clipboard history" checked={settings.extra.preventClipboardHistory} onChange={(v) => updateSetting('extra', 'preventClipboardHistory', v)} />
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1 mb-1">Local Service Security</span>
          <div className="flex flex-col gap-2 pt-1">
            <Checkbox label="Bind the service to 127.0.0.1 only" checked={settings.extra.bindLocalhostOnly} onChange={(v) => updateSetting('extra', 'bindLocalhostOnly', v)} />
            <Checkbox label="Reject external control requests" checked={settings.extra.rejectExternalRequests} onChange={(v) => updateSetting('extra', 'rejectExternalRequests', v)} />
          </div>

          <div className="space-y-1 pt-2">
            <label className="text-[11px] text-slate-400 font-bold block">Trusted Origins</label>
            <input
              type="text"
              value={settings.extra.trustedOrigins}
              onChange={(e) => updateSetting('extra', 'trustedOrigins', e.target.value)}
              className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded p-2 text-xs font-mono text-left"
              style={{ direction: 'ltr' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
