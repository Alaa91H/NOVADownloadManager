/* src/dialogs/settings/sections/GeneralAndDownloads.tsx */
import React, { useState, useEffect } from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { Switch, SelectField, Checkbox, Button } from '../../../components/primitives';
import { Settings, Folder, RefreshCw, AlertTriangle, Play, FileText, Volume2 } from 'lucide-react';
import { WORLD_LANGUAGES } from '../../../lib/languages';
import { useToastActions, useI18n } from '../../../store/selectors';
import { tauriClient } from '../../../api/tauriClient';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onTestNotification: () => void;
  onResetDaemonTab: () => void;
  onResetAll: () => void;
}

export const GeneralAndDownloads: React.FC<Props> = ({
  settings,
  updateSetting,
  onTestNotification,
  onResetDaemonTab,
  onResetAll,
}) => {
  const { addToast } = useToastActions();
  const t = useI18n();
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [updateResult, setUpdateResult] = useState<{ hasUpdate: boolean; currentVersion: string; latestVersion: string; performUpdate?: () => Promise<void> } | null>(null);
  // Placeholder showing the expected default path (resolved on mount)
  const [defaultPathHint, setDefaultPathHint] = useState('');

  useEffect(() => {
    if (settings.saveAndCategories.defaultFolder) return;
    void tauriClient.getDownloadsDir().then((dir) => {
      if (!dir) return;
      const sep = dir.includes('\\') ? '\\' : '/';
      setDefaultPathHint(`${dir.replace(/[\\/]+$/, '')}${sep}NOVA`);
    });
  }, [settings.saveAndCategories.defaultFolder]);

  const handlePickDefaultFolder = async () => {
    const current = settings.saveAndCategories.defaultFolder;
    const picked = await tauriClient.showDirectoryPicker(current || undefined);
    if (picked) {
      updateSetting('saveAndCategories', 'defaultFolder', picked);
    } else {
      addToast('info', t('settings_default_folder'), 'Type the path manually if folder picker is unavailable.');
    }
  };

  const handlePickTempFolder = async () => {
    const current = settings.saveAndCategories.tempFolder;
    const picked = await tauriClient.showDirectoryPicker(current || undefined);
    if (picked) {
      updateSetting('saveAndCategories', 'tempFolder', picked);
    } else {
      addToast('info', t('settings_temp_folder'), 'Type the path manually if folder picker is unavailable.');
    }
  };

  const handlePickCategoryFolder = async (cat: string) => {
    const current = (settings.saveAndCategories.categoryFolders as Record<string, string>)[cat];
    const picked = await tauriClient.showDirectoryPicker(current || undefined);
    if (picked) {
      const catFolders = { ...settings.saveAndCategories.categoryFolders, [cat]: picked };
      updateSetting('saveAndCategories', 'categoryFolders', catFolders);
    }
  };

  const handleCheckPermissions = async () => {
    const folder = settings.saveAndCategories.defaultFolder;
    if (!folder) {
      addToast('warning', t('settings_check_permissions'), 'Set a default download folder first.');
      return;
    }
    // Try to open the folder in Explorer as a lightweight permission check.
    const ok = await tauriClient.openInExplorer(folder).catch(() => false);
    if (ok) {
      addToast('success', t('settings_check_permissions'), `Folder is accessible: ${folder}`);
    } else {
      addToast('warning', t('settings_check_permissions'), `Could not access folder — it may not exist yet: ${folder}`);
    }
  };

  const categoryLabels: Record<string, string> = {
    document: t('settings_cat_documents'),
    program: t('settings_cat_programs'),
    compressed: t('settings_cat_compressed'),
    video: t('settings_cat_videos'),
    audio: t('settings_cat_audio'),
    other: t('settings_cat_other'),
  };

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
      } else {
        addToast(
          'success',
          t('settings_update_current'),
          t('settings_update_current_msg', { version: result.currentVersion }),
        );
      }
    } catch (error) {
      addToast(
        'error',
        t('settings_update_failed'),
        error instanceof Error ? error.message : t('settings_update_failed_msg'),
      );
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
      addToast('error', t('settings_update_failed'), error instanceof Error ? error.message : 'Update installation failed.');
      setUpdateDownloading(false);
      setUpdateProgress(null);
    }
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Settings className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">{t('settings_general_system_title')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/25 p-3 rounded-lg border border-[var(--border-color)] divide-y divide-[var(--border-color)]/40">
          {[
            {
              label: t('settings_launch_startup'),
              checked: settings.general.runOnStartup,
              onChange: (v: boolean) => {
                updateSetting('general', 'runOnStartup', v);
              },
            },
            {
              label: t('settings_minimize_tray'),
              checked: settings.general.showTrayIcon,
              onChange: (v: boolean) => {
                updateSetting('general', 'showTrayIcon', v);
              },
            },
            {
              label: t('settings_monitor_clipboard'),
              checked: settings.general.monitorClipboard,
              onChange: (v: boolean) => {
                updateSetting('general', 'monitorClipboard', v);
              },
            },
            {
              label: t('settings_confirm_delete'),
              checked: settings.general.confirmOnDelete,
              onChange: (v: boolean) => {
                updateSetting('general', 'confirmOnDelete', v);
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
                    ? (updateProgress ? `Downloading... ${String(Math.round((updateProgress.downloaded / updateProgress.total) * 100))}%` : 'Downloading...')
                    : t('settings_install_update')}
                </Button>
              )}
            </div>
          </div>
          {updateResult && (
            <p className="text-[10px] text-[var(--text-secondary)] font-mono">
              {t('settings_update_versions', {
                current: updateResult.currentVersion,
                latest: updateResult.latestVersion,
              })}
            </p>
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
          <SelectField
            label={t('settings_timezone_format')}
            value={settings.extra.timezone}
            onChange={(e) => {
              updateSetting('extra', 'timezone', e.target.value);
            }}
            options={[
              { value: 'system', label: t('settings_timezone_system') },
              { value: 'utc', label: 'UTC' },
            ]}
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Folder className="w-4 h-4 text-[var(--success)]" />
          <h3 className="text-sm font-extrabold text-[var(--success)]">{t('settings_download_folders')}</h3>
        </div>

        <div className="space-y-3">
          {/* Default folder with folder-picker button */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wide">
              {t('settings_default_folder')}
            </label>
            <div className="relative flex items-center gap-1">
              <input
                type="text"
                value={settings.saveAndCategories.defaultFolder}
                placeholder={defaultPathHint || 'e.g. C:\\Users\\You\\Downloads\\NOVA'}
                onChange={(e) => {
                  updateSetting('saveAndCategories', 'defaultFolder', e.target.value);
                }}
                className="flex-1 bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2.5 py-1.5 text-xs font-mono text-left focus:border-[var(--accent-primary)] focus:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                style={{ direction: 'ltr' }}
              />
              <button
                type="button"
                onClick={() => {
                  void handlePickDefaultFolder();
                }}
                title="Browse"
                className="shrink-0 p-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-hover)] hover:bg-[var(--bg-sidebar)] text-[var(--text-secondary)] hover:text-[var(--accent-primary)] transition-colors cursor-pointer"
              >
                <Folder className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Temp folder with folder-picker button */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wide">
              {t('settings_temp_folder')}
            </label>
            <div className="relative flex items-center gap-1">
              <input
                type="text"
                value={settings.saveAndCategories.tempFolder}
                placeholder={
                  defaultPathHint ? `${defaultPathHint}/.temp` : 'e.g. C:\\Users\\You\\Downloads\\NOVA\\.temp'
                }
                onChange={(e) => {
                  updateSetting('saveAndCategories', 'tempFolder', e.target.value);
                }}
                className="flex-1 bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2.5 py-1.5 text-xs font-mono text-left focus:border-[var(--accent-primary)] focus:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                style={{ direction: 'ltr' }}
              />
              <button
                type="button"
                onClick={() => {
                  void handlePickTempFolder();
                }}
                title="Browse"
                className="shrink-0 p-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-hover)] hover:bg-[var(--bg-sidebar)] text-[var(--text-secondary)] hover:text-[var(--accent-primary)] transition-colors cursor-pointer"
              >
                <Folder className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              onClick={() => {
                void handleCheckPermissions();
              }}
              variant="secondary"
              size="md"
              className="text-[var(--success)] hover:text-[var(--success)] border-[var(--success-border)] bg-[var(--success-bg)] hover:bg-[var(--success)]/25"
            >
              {t('settings_check_permissions')}
            </Button>

          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1 mb-2">
            {t('settings_automatic_categories')}
          </span>
          <div className="grid grid-cols-1 gap-3">
            {(
              Object.keys(settings.saveAndCategories.categoryFolders) as Array<
                keyof typeof settings.saveAndCategories.categoryFolders
              >
            ).map((cat) => (
              <div key={cat} className="flex flex-col gap-1">
                <label className="text-[10px] text-[var(--text-muted)] font-bold">{categoryLabels[cat]}</label>
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={settings.saveAndCategories.categoryFolders[cat]}
                    placeholder={defaultPathHint ? `${defaultPathHint}\\${categoryLabels[cat]}` : ''}
                    onChange={(e) => {
                      const catFolders = { ...settings.saveAndCategories.categoryFolders, [cat]: e.target.value };
                      updateSetting('saveAndCategories', 'categoryFolders', catFolders);
                    }}
                    className="flex-1 bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2.5 py-1 text-xs font-mono text-left focus:border-[var(--accent-primary)] focus:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                    style={{ direction: 'ltr' }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void handlePickCategoryFolder(cat);
                    }}
                    title="Browse"
                    className="shrink-0 p-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-hover)] hover:bg-[var(--bg-sidebar)] text-[var(--text-secondary)] hover:text-[var(--accent-primary)] transition-colors cursor-pointer"
                  >
                    <Folder className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-1 mb-1">
            <FileText className="w-4 h-4 text-[var(--info)]" />
            <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block">
              {t('settings_file_types_title')}
            </span>
          </div>
          <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">{t('settings_file_types_desc')}</p>
          {(
            Object.keys(settings.fileTypes.extensions) as Array<keyof typeof settings.fileTypes.extensions>
          ).map((cat) => (
            <div key={cat} className="flex flex-col gap-1">
              <label className="text-[10px] text-[var(--text-muted)] font-bold">
                {t(`settings_file_types_${cat}`)}
              </label>
              <input
                type="text"
                value={settings.fileTypes.extensions[cat].join(', ')}
                placeholder={t('settings_file_types_placeholder')}
                onChange={(e) => {
                  const parsed = e.target.value
                    .split(',')
                    .map((s) => s.trim().replace(/^\./, ''))
                    .filter(Boolean);
                  updateSetting('fileTypes', 'extensions', { ...settings.fileTypes.extensions, [cat]: parsed });
                }}
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2.5 py-1.5 text-xs font-mono text-left focus:border-[var(--accent-primary)] focus:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                style={{ direction: 'ltr' }}
              />
            </div>
          ))}
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">
            {t('settings_duplicates_resume')}
          </span>
          <SelectField
            label={t('settings_duplicate_action')}
            value={settings.extra.duplicateAction}
            onChange={(e) => {
              updateSetting('extra', 'duplicateAction', e.target.value);
            }}
            options={[
              { value: 'rename', label: t('settings_duplicate_rename') },
              { value: 'overwrite', label: t('settings_duplicate_overwrite') },
              { value: 'skip', label: t('settings_duplicate_skip') },
              { value: 'resume', label: t('settings_duplicate_resume') },
            ]}
          />
          <div className="flex flex-col gap-2 pt-2">
            <Checkbox
              label={t('settings_verify_ranges')}
              checked={settings.extra.checkRanges}
              onChange={(v) => {
                updateSetting('extra', 'checkRanges', v);
              }}
            />
            <Checkbox
              label={t('settings_warn_duplicate')}
              checked={settings.extra.warnOnDuplicate}
              onChange={(v) => {
                updateSetting('extra', 'warnOnDuplicate', v);
              }}
            />
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">
            {t('settings_after_download')}
          </span>
          <div className="grid grid-cols-1 gap-3">
            <Checkbox
              label={t('settings_open_file_auto')}
              checked={settings.extra.openOnComplete}
              onChange={(v) => {
                updateSetting('extra', 'openOnComplete', v);
              }}
            />
            <Checkbox
              label={t('settings_open_folder_auto')}
              checked={settings.extra.openFolderOnComplete}
              onChange={(v) => {
                updateSetting('extra', 'openFolderOnComplete', v);
              }}
            />
            <Checkbox
              label={t('settings_show_notification')}
              checked={settings.sounds.enabled}
              onChange={(v) => {
                updateSetting('sounds', 'enabled', v);
              }}
            />
            <Checkbox
              label={t('settings_virus_scan')}
              checked={settings.extra.virusScan}
              onChange={(v) => {
                updateSetting('extra', 'virusScan', v);
              }}
            />
          </div>
          <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-1">
            <Volume2 className="w-4 h-4 text-[var(--accent-primary)]" />
            <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block">
              {t('sound_alerts')}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <SelectField
              label={t('settings_sound_on_start')}
              value={settings.sounds.onStart || 'off'}
              onChange={(e) => {
                updateSetting('sounds', 'onStart', e.target.value);
              }}
              options={[
                { value: 'off', label: t('sound_off') },
                { value: 'soft', label: t('sound_soft') },
                { value: 'tap', label: t('sound_tap') },
                { value: 'chime', label: t('sound_chime') },
                { value: 'alert', label: t('sound_alert') },
              ]}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1 border-t border-[var(--border-color)]/50">
            <Button
              type="button"
              onClick={onTestNotification}
              variant="secondary"
              size="md"
              icon={Play}
              className="text-[var(--success)] hover:text-[var(--success)]"
            >
              {t('settings_test_notification')}
            </Button>
          </div>
        </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-[var(--border-color)]/60">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-[var(--danger)] animate-pulse" />
            <h3 className="text-sm font-extrabold text-[var(--danger)]">{t('settings_reset_controls')}</h3>
          </div>
          <div className="bg-[var(--danger-bg)] p-4 rounded-xl border border-[var(--danger)]/15 flex flex-col lg:flex-row gap-4 justify-between items-center">
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed max-w-lg">{t('settings_reset_desc')}</p>
            <div className="flex flex-col sm:flex-row gap-2.5 shrink-0 w-full lg:w-auto">
              <Button
                type="button"
                onClick={onResetDaemonTab}
                variant="secondary"
                size="md"
                icon={RefreshCw}
                className="border-[var(--danger-border)] text-[var(--danger)] hover:text-[var(--danger)] bg-[var(--danger-bg)] hover:bg-[var(--danger-bg)] w-full sm:w-auto text-center"
              >
                {t('settings_reset_service')}
              </Button>
              <Button
                type="button"
                onClick={onResetAll}
                variant="danger"
                size="md"
                icon={AlertTriangle}
                className="w-full sm:w-auto text-center"
              >
                {t('settings_reset_all')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
