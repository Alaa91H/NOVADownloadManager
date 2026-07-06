/* src/dialogs/settings/sections/GeneralAndDownloads.tsx */
import React from 'react';
import { AppSettings } from '../../../types/desktop-ui.types';
import { Switch, TextField, SelectField, Checkbox, Button } from '../../../components/primitives';
import { Settings, Folder, RefreshCw, AlertTriangle, Play } from 'lucide-react';
import { WORLD_LANGUAGES } from '../../../lib/languages';
import { useAppStore } from '../../../state/appStore';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onTestNotification: () => void;
  onClearPartials: () => void;
  onResetDaemonTab: () => void;
  onResetAll: () => void;
}

export const GeneralAndDownloads: React.FC<Props> = ({
  settings,
  updateSetting,
  onTestNotification,
  onClearPartials,
  onResetDaemonTab,
  onResetAll,
}) => {
  const { t } = useAppStore();

  const categoryLabels: Record<string, string> = {
    document: t('settings_cat_documents'),
    program: t('settings_cat_programs'),
    compressed: t('settings_cat_compressed'),
    video: t('settings_cat_videos'),
    audio: t('settings_cat_audio'),
    other: t('settings_cat_other'),
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
          <Folder className="w-4 h-4 text-emerald-500" />
          <h3 className="text-sm font-extrabold text-emerald-400">{t('settings_download_folders')}</h3>
        </div>

        <div className="space-y-3">
          <TextField
            label={t('settings_default_folder')}
            value={settings.saveAndCategories.defaultFolder}
            onChange={(e) => {
              updateSetting('saveAndCategories', 'defaultFolder', e.target.value);
            }}
          />
          <TextField
            label={t('settings_temp_folder')}
            value={settings.saveAndCategories.tempFolder}
            onChange={(e) => {
              updateSetting('saveAndCategories', 'tempFolder', e.target.value);
            }}
          />

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              onClick={() => {
                alert('Folder permissions look good.');
              }}
              variant="secondary"
              size="md"
              className="text-emerald-400 hover:text-emerald-300 border-emerald-500/20 bg-emerald-500/10 hover:bg-emerald-500/25"
            >
              {t('settings_check_permissions')}
            </Button>
            <Button
              type="button"
              onClick={onClearPartials}
              variant="secondary"
              size="md"
              className="text-amber-400 hover:text-amber-300 border-amber-500/20 bg-amber-500/10 hover:bg-amber-500/25"
            >
              {t('settings_clean_temp')}
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
                <label className="text-[10px] text-slate-400 font-bold">{categoryLabels[cat]}</label>
                <input
                  type="text"
                  value={settings.saveAndCategories.categoryFolders[cat]}
                  onChange={(e) => {
                    const catFolders = { ...settings.saveAndCategories.categoryFolders, [cat]: e.target.value };
                    updateSetting('saveAndCategories', 'categoryFolders', catFolders);
                  }}
                  className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2.5 py-1 text-xs font-mono text-left"
                  style={{ direction: 'ltr' }}
                />
              </div>
            ))}
          </div>
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
          <div className="flex justify-end gap-2 pt-1 border-t border-[var(--border-color)]/50">
            <Button
              type="button"
              onClick={onTestNotification}
              variant="secondary"
              size="md"
              icon={Play}
              className="text-emerald-400 hover:text-emerald-300"
            >
              {t('settings_test_notification')}
            </Button>
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-[var(--border-color)]/60">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500 animate-pulse" />
            <h3 className="text-sm font-extrabold text-red-400">{t('settings_reset_controls')}</h3>
          </div>
          <div className="bg-red-500/5 p-4 rounded-xl border border-red-500/15 flex flex-col lg:flex-row gap-4 justify-between items-center">
            <p className="text-[11px] text-slate-400 leading-relaxed max-w-lg">{t('settings_reset_desc')}</p>
            <div className="flex flex-col sm:flex-row gap-2.5 shrink-0 w-full lg:w-auto">
              <Button
                type="button"
                onClick={onResetDaemonTab}
                variant="secondary"
                size="md"
                icon={RefreshCw}
                className="border-red-500/20 text-red-400 hover:text-red-300 bg-red-500/5 hover:bg-red-500/15 w-full sm:w-auto text-center"
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
