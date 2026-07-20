/* src/dialogs/settings/sections/BrowserAndIntegration.tsx */
import React, { useState } from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, TextField } from '../../../components/primitives';
import { Puzzle, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { useDialogActions, useI18n } from '../../../store/selectors';
import { novaClient } from '../../../api/novaClient';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
}

const generatePairingToken = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `nova_token_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const BrowserAndIntegration: React.FC<Props> = ({ settings, updateSetting, onAddToast }) => {
  const t = useI18n();
  const { openDialog } = useDialogActions();
  const [showPairingToken, setShowPairingToken] = useState(false);
  const [isPairing, setIsPairing] = useState(false);
  const ignoreSites = settings.extra.ignoreSites;
  const setIgnoreSites = (val: string) => {
    updateSetting('extra', 'ignoreSites', val);
  };

  const handleRegenerateToken = () => {
    openDialog('genericConfirm', {
      message: 'Generate a new pairing token? Installed browser extensions will need to be paired again.',
      isDanger: true,
      onConfirm: () => {
        updateSetting('extra', 'browserPairingToken', generatePairingToken());
        onAddToast('success', t('settings_toast_regenerate_token'), t('settings_toast_token_regenerated'));
      },
    });
  };

  const handleTestExtensionConnection = async () => {
    setIsPairing(true);
    try {
      const enabled = Object.values(settings.general.integrateWithBrowsers).some(Boolean);
      const health = await novaClient.configureBrowserExtension({
        enabled,
        token: settings.extra.browserPairingToken,
        minSizeMb: settings.fileTypes.autoDownloadMaxSizeMb,
        defaultFolder: settings.saveAndCategories.defaultFolder,
        categoryFolders: settings.saveAndCategories.categoryFolders,
        userAgent: settings.extra.userAgent,
      });
      onAddToast(
        'success',
        t('settings_toast_extension_bridge'),
        `Browser capture is ${health.enabled ? 'enabled' : 'disabled'} and the local bridge is reachable.`,
      );
    } catch (error) {
      onAddToast(
        'error',
        t('settings_toast_extension_offline'),
        error instanceof Error ? error.message : t('settings_toast_extension_fallback'),
      );
    } finally {
      setIsPairing(false);
    }
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Puzzle className="w-4 h-4 text-[var(--info)]" />
          <h3 className="text-sm font-extrabold text-[var(--info)]">{t('settings_browser_integration')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">
            {t('settings_extension_pairing')}
          </span>

          <div className="space-y-2">
            <span className="text-[11px] text-[var(--text-secondary)] font-bold block">
              {t('settings_capture_browsers')}
            </span>
            {(['chrome', 'edge', 'firefox', 'safari'] as const).map((browser) => (
              <FormRow key={browser} label={t(`settings_browser_${browser}`)}>
                <Switch
                  checked={settings.general.integrateWithBrowsers[browser]}
                  onChange={(v) => {
                    updateSetting('general', 'integrateWithBrowsers', {
                      ...settings.general.integrateWithBrowsers,
                      [browser]: v,
                    });
                  }}
                />
              </FormRow>
            ))}
          </div>

          <div className="flex flex-col gap-1.5 pt-1.5">
            <label className="text-[11px] text-[var(--text-muted)] font-bold">{t('settings_pairing_token')}</label>
            <div className="flex gap-2">
              <input
                type={showPairingToken ? 'text' : 'password'}
                value={settings.extra.browserPairingToken}
                readOnly
                className="flex-1 bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-3 py-1.5 text-xs font-mono text-left"
                style={{ direction: 'ltr' }}
              />
              <button
                type="button"
                onClick={() => {
                  setShowPairingToken(!showPairingToken);
                }}
                className="px-2.5 bg-[var(--bg-hover)] hover:bg-[var(--border-color-hover)] text-[var(--text-primary)] rounded border border-[var(--border-color)] cursor-pointer flex items-center justify-center"
                title={t('settings_token_desc')}
              >
                {showPairingToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={handleRegenerateToken}
                className="px-3 bg-[var(--danger-bg)] hover:bg-[var(--danger-bg)] text-[var(--danger)] border border-[var(--danger-border)] rounded text-xs font-bold cursor-pointer"
              >
                {t('settings_generate_token')}
              </button>
            </div>
            <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">{t('settings_token_desc')}</p>
          </div>

          <div className="flex justify-end pt-2 border-t border-[var(--border-color)]/30">
            <button
              type="button"
              onClick={() => {
                void handleTestExtensionConnection();
              }}
              disabled={isPairing}
              className="px-3 py-1.5 bg-[var(--info-bg)] border border-[var(--info-border)] text-[var(--info)] rounded text-xs font-bold hover:bg-[var(--info-bg)] transition-all cursor-pointer flex items-center gap-1.5"
            >
              {isPairing && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              {t('settings_test_extension')}
            </button>
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">
            {t('settings_capture_filters')}
          </span>

          <TextField
            label={t('settings_min_capture_size')}
            type="number"
            value={settings.fileTypes.autoDownloadMaxSizeMb}
            onChange={(e) => {
              updateSetting('fileTypes', 'autoDownloadMaxSizeMb', Number(e.target.value));
            }}
            placeholder="128"
          />

          <div className="space-y-1">
            <label className="text-[11px] text-[var(--text-muted)] font-bold block">{t('settings_ignore_sites')}</label>
            <input
              type="text"
              value={ignoreSites}
              onChange={(e) => {
                setIgnoreSites(e.target.value);
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
