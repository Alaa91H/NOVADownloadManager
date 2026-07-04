/* src/dialogs/settings/sections/GeneralAndDownloads.tsx */
import React from 'react';
import { AppSettings } from '../../../types/desktop-ui.types';
import { Switch, TextField, SelectField, Checkbox, Button } from '../../../components/primitives';
import { Settings, Folder, RefreshCw, AlertTriangle, Play } from 'lucide-react';
import { WORLD_LANGUAGES } from '../../../lib/languages';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onTestNotification: () => void;
  onClearPartials: () => void;
  onResetDaemonTab: () => void;
  onResetAll: () => void;
}

const categoryLabels: Record<string, string> = {
  document: 'Documents & Books',
  program: 'Programs & Apps',
  compressed: 'Compressed Files',
  video: 'Videos & Media',
  audio: 'Audio & Music',
  other: 'Other Files',
};

export const GeneralAndDownloads: React.FC<Props> = ({
  settings,
  updateSetting,
  onTestNotification,
  onClearPartials,
  onResetDaemonTab,
  onResetAll,
}) => {
  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Settings className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">General System Settings</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/25 p-3 rounded-lg border border-[var(--border-color)] divide-y divide-[var(--border-color)]/40">
          {[
            { label: 'Launch NOVA when Windows starts', checked: settings.general.runOnStartup, onChange: (v: boolean) => updateSetting('general', 'runOnStartup', v) },
            { label: 'Minimize to the system tray when closing the window', checked: settings.general.showTrayIcon, onChange: (v: boolean) => updateSetting('general', 'showTrayIcon', v) },
            { label: 'Monitor clipboard for copied download links', checked: settings.general.monitorClipboard, onChange: (v: boolean) => updateSetting('general', 'monitorClipboard', v) },
            { label: 'Confirm before deleting downloads', checked: settings.general.confirmOnDelete, onChange: (v: boolean) => updateSetting('general', 'confirmOnDelete', v) },
            { label: 'Check for application updates automatically', checked: settings.general.checkUpdates, onChange: (v: boolean) => updateSetting('general', 'checkUpdates', v) },
          ].map((item) => (
            <div key={item.label} className="flex items-center justify-between py-2.5">
              <span className="text-xs font-bold text-[var(--text-primary)]">{item.label}</span>
              <Switch checked={item.checked} onChange={item.onChange} />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4">
          <SelectField
            label="Interface Language"
            value={settings.extra.language || 'en'}
            onChange={(e) => updateSetting('extra', 'language', e.target.value || 'en')}
            options={WORLD_LANGUAGES}
          />
          <SelectField
            label="Timezone & Date Format"
            value={settings.extra.timezone}
            onChange={(e) => updateSetting('extra', 'timezone', e.target.value)}
            options={[
              { value: 'system', label: 'Use system settings' },
              { value: 'utc', label: 'UTC' },
            ]}
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Folder className="w-4 h-4 text-emerald-500" />
          <h3 className="text-sm font-extrabold text-emerald-400">Download Folders</h3>
        </div>

        <div className="space-y-3">
          <TextField
            label="Default Downloads Folder"
            value={settings.saveAndCategories.defaultFolder}
            onChange={(e) => updateSetting('saveAndCategories', 'defaultFolder', e.target.value)}
          />
          <TextField
            label="Temporary Parts Folder"
            value={settings.saveAndCategories.tempFolder}
            onChange={(e) => updateSetting('saveAndCategories', 'tempFolder', e.target.value)}
          />

          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => alert('Folder permissions look good.')} variant="secondary" size="md" className="text-emerald-400 hover:text-emerald-300 border-emerald-500/20 bg-emerald-500/10 hover:bg-emerald-500/25">
              Check Folder Permissions
            </Button>
            <Button type="button" onClick={onClearPartials} variant="secondary" size="md" className="text-amber-400 hover:text-amber-300 border-amber-500/20 bg-amber-500/10 hover:bg-amber-500/25">
              Clean Temporary Parts
            </Button>
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1 mb-2">Automatic Category Folders</span>
          <div className="grid grid-cols-1 gap-3">
            {(Object.keys(settings.saveAndCategories.categoryFolders) as Array<keyof typeof settings.saveAndCategories.categoryFolders>).map(cat => (
              <div key={cat} className="flex flex-col gap-1">
                <label className="text-[10px] text-slate-400 font-bold">{categoryLabels[String(cat)]}</label>
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
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">Duplicates & Resume Handling</span>
          <SelectField
            label="When a duplicate file is added"
            value={settings.extra.duplicateAction}
            onChange={(e) => updateSetting('extra', 'duplicateAction', e.target.value)}
            options={[
              { value: 'rename', label: 'Rename automatically' },
              { value: 'overwrite', label: 'Overwrite existing file' },
              { value: 'skip', label: 'Skip the download' },
              { value: 'resume', label: 'Resume into the existing file' },
            ]}
          />
          <div className="flex flex-col gap-2 pt-2">
            <Checkbox label="Verify resume support with Accept-Ranges" checked={settings.extra.checkRanges} onChange={(v) => updateSetting('extra', 'checkRanges', v)} />
            <Checkbox label="Warn before adding a duplicate download" checked={settings.extra.warnOnDuplicate} onChange={(v) => updateSetting('extra', 'warnOnDuplicate', v)} />
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">After Download Completes</span>
          <div className="grid grid-cols-1 gap-3">
            <Checkbox label="Open the file automatically" checked={settings.extra.openOnComplete} onChange={(v) => updateSetting('extra', 'openOnComplete', v)} />
            <Checkbox label="Open the containing folder" checked={settings.extra.openFolderOnComplete} onChange={(v) => updateSetting('extra', 'openFolderOnComplete', v)} />
            <Checkbox label="Show a system notification and play a sound" checked={settings.sounds.enabled} onChange={(v) => updateSetting('sounds', 'enabled', v)} />
            <Checkbox label="Scan completed files with antivirus" checked={settings.extra.virusScan} onChange={(v) => updateSetting('extra', 'virusScan', v)} />
          </div>
          <div className="flex justify-end gap-2 pt-1 border-t border-[var(--border-color)]/50">
            <Button type="button" onClick={onTestNotification} variant="secondary" size="md" icon={Play} className="text-emerald-400 hover:text-emerald-300">
              Test Completion Notification
            </Button>
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-[var(--border-color)]/60">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500 animate-pulse" />
            <h3 className="text-sm font-extrabold text-red-400">Reset Controls</h3>
          </div>
          <div className="bg-red-500/5 p-4 rounded-xl border border-red-500/15 flex flex-col lg:flex-row gap-4 justify-between items-center">
            <p className="text-[11px] text-slate-400 leading-relaxed max-w-lg">
              Restore service defaults or reset all local preferences immediately.
            </p>
            <div className="flex flex-col sm:flex-row gap-2.5 shrink-0 w-full lg:w-auto">
              <Button type="button" onClick={onResetDaemonTab} variant="secondary" size="md" icon={RefreshCw} className="border-red-500/20 text-red-400 hover:text-red-300 bg-red-500/5 hover:bg-red-500/15 w-full sm:w-auto text-center">
                Reset Service Settings
              </Button>
              <Button type="button" onClick={onResetAll} variant="danger" size="md" icon={AlertTriangle} className="w-full sm:w-auto text-center">
                Reset All Settings
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
