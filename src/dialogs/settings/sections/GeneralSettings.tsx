/* src/dialogs/settings/sections/GeneralSettings.tsx */
import React, { useState } from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { Switch, SelectField, Button } from '../../../components/primitives';
import { Settings, RefreshCw } from 'lucide-react';
import { WORLD_LANGUAGES } from '../../../lib/languages';
import { useToastActions, useI18n } from '../../../store/selectors';
import { tauriClient, type TauriUpdateResult } from '../../../api/tauriClient';
import { extractErrorMessage } from '../../../utils/formatUtils';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
}

export const GeneralSettings: React.FC<Props> = ({ settings, updateSetting }) => {
  const { addToast } = useToastActions();
  const t = useI18n();
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [updateResult, setUpdateResult] = useState<TauriUpdateResult | null>(null);

  const handleCheckUpdates = async () => {
    setUpdateChecking(true);
    try {
      const result = await tauriClient.checkTauriUpdate((downloaded, total) => {
        setUpdateProgress({ downloaded, total });
      });
      setUpdateResult(result);
      if (result.hasUpdate) {
        addToast(
          'info',
          t('settings_update_available'),
          t('settings_update_available_msg', { version: result.latestVersion }),
        );
      } else if (result.unavailableMessage) {
        addToast('info', 'Signed in-app updates unavailable', result.unavailableMessage);
      } else {
        addToast(
          'success',
          t('settings_update_current'),
          t('settings_update_current_msg', { version: result.currentVersion }),
        );
      }
    } catch (error) {
      addToast('error', t('settings_update_failed'), extractErrorMessage(error, t('settings_update_failed_msg')));
    } finally {
      setUpdateChecking(false);
    }
  };

  const handleOpenUpdate = async () => {
    if (!updateResult?.performUpdate) return;
    setUpdateDownloading(true);
    try {
      await updateResult.performUpdate();
    } catch (error) {
      addToast('error', t('settings_update_failed'), extractErrorMessage(error, 'Update installation failed.'));
      setUpdateDownloading(false);
      setUpdateProgress(null);
    }
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Settings className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">System</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/25 p-3 rounded-lg border border-[var(--border-color)] divide-y divide-[var(--border-color)]/40">
          {[
            {
              label: t('settings_monitor_clipboard'),
              checked: settings.general.monitorClipboard,
              onChange: (v: boolean) => {
                updateSetting('general', 'monitorClipboard', v);
              },
            },
            {
              label: t('settings_check_updates'),
              checked: settings.general.checkUpdates,
              onChange: (v: boolean) => {
                updateSetting('general', 'checkUpdates', v);
              },
            },
          ].map((item) => (
            <div key={item.label} className="flex items-center justify-between py-2.5">
              <span className="text-xs font-bold text-[var(--text-primary)]">{item.label}</span>
              <Switch checked={item.checked} onChange={item.onChange} />
            </div>
          ))}
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <span className="text-xs font-extrabold text-[var(--text-primary)]">
                {t('settings_unsigned_updates')}
              </span>
              <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
                {t('settings_unsigned_updates_desc')}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button
                type="button"
                onClick={() => {
                  void handleCheckUpdates();
                }}
                disabled={updateChecking || updateDownloading}
                variant="secondary"
                size="md"
                icon={RefreshCw}
                className="text-[var(--info)] hover:text-[var(--info)]"
              >
                {updateChecking ? t('settings_checking_updates') : t('settings_check_now')}
              </Button>
              {updateResult?.unavailableMessage && (
                <Button
                  type="button"
                  onClick={() => {
                    void tauriClient.openExternalUrl('https://github.com/Alaa91H/NOVADownloadManager/releases');
                  }}
                  disabled={updateDownloading}
                  variant="secondary"
                  size="md"
                >
                  Open releases
                </Button>
              )}
              {updateResult?.hasUpdate && (
                <Button
                  type="button"
                  onClick={() => {
                    void handleOpenUpdate();
                  }}
                  disabled={updateDownloading}
                  variant="primary"
                  size="md"
                >
                  {updateDownloading
                    ? updateProgress
                      ? `Downloading... ${String(Math.round((updateProgress.downloaded / updateProgress.total) * 100))}%`
                      : 'Downloading...'
                    : t('settings_install_update')}
                </Button>
              )}
            </div>
          </div>
          {updateResult && (
            <div className="space-y-1">
              <p className="text-[10px] text-[var(--text-secondary)] font-mono">
                {t('settings_update_versions', {
                  current: updateResult.currentVersion,
                  latest: updateResult.latestVersion,
                })}
              </p>
              {updateResult.unavailableMessage && (
                <p className="text-[10px] text-[var(--warning)] leading-relaxed">{updateResult.unavailableMessage}</p>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4">
          <SelectField
            label={t('settings_interface_language')}
            value={settings.extra.language || 'en'}
            onChange={(e) => {
              updateSetting('extra', 'language', e.target.value || 'en');
            }}
            options={WORLD_LANGUAGES}
          />
        </div>
      </div>
    </div>
  );
};
