/* src/dialogs/settings/sections/SecuritySettings.tsx */
import React from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { Checkbox } from '../../../components/primitives';
import { Shield } from 'lucide-react';
import { useI18n } from '../../../store/selectors';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
}

export const SecuritySettings: React.FC<Props> = ({ settings, updateSetting }) => {
  const t = useI18n();

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
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
