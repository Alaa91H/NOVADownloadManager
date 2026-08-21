/* src/dialogs/settings/sections/BackupResetSettings.tsx */
import React, { useRef } from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { Database, AlertTriangle, Upload } from 'lucide-react';
import { useSettingsActions, useI18n } from '../../../store/selectors';

interface Props {
  settings: AppSettings;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
  onFactoryReset: () => void;
}

export function sanitizeSettingsBackup(settings: AppSettings): AppSettings {
  return {
    ...settings,
    connection: { ...settings.connection, proxyUser: '', proxyPass: '' },
    extra: { ...settings.extra, tgBotToken: '', browserPairingToken: '' },
  };
}

export const BackupResetSettings: React.FC<Props> = ({ settings, onAddToast, onFactoryReset }) => {
  const t = useI18n();
  const { updateSettings } = useSettingsActions();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExportSettings = () => {
    const jsonString = JSON.stringify(sanitizeSettingsBackup(settings), null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', url);
    downloadAnchor.setAttribute('download', `nova_settings_backup_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    URL.revokeObjectURL(url);
    onAddToast('success', t('settings_toast_exported'), t('settings_toast_exported_msg'));
  };

  const handleImportSettings = () => {
    fileInputRef.current?.click();
  };

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as Partial<AppSettings>;
        const merged = { ...settings, ...parsed };
        updateSettings(merged, true);
        onAddToast('success', t('settings_import_success'), t('settings_import_success_msg'));
      } catch {
        onAddToast('error', t('settings_import_error'), t('settings_import_error_msg'));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4 animate-in fade-in duration-150">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Database className="w-4 h-4 text-[var(--warning)]" />
          <h3 className="text-xs font-extrabold text-[var(--warning)]">{t('settings_backup_restore')}</h3>
        </div>
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{t('settings_backup_desc')}</p>
        <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFileChange} />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleExportSettings}
            className="px-3 py-1.5 bg-[var(--warning-bg)] border border-[var(--warning-border)] text-[var(--warning)] rounded text-xs font-bold hover:bg-[var(--warning-bg)] transition-all cursor-pointer flex items-center gap-1"
          >
            <Upload className="w-3.5 h-3.5" />
            {t('settings_export')}
          </button>
          <button
            type="button"
            onClick={handleImportSettings}
            className="px-3 py-1.5 bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-primary)] rounded text-xs font-bold hover:bg-[var(--border-color-hover)] transition-all cursor-pointer flex items-center gap-1"
          >
            <Upload className="w-3.5 h-3.5" />
            {t('settings_import')}
          </button>
        </div>
        <div className="bg-[var(--danger-bg)] border border-[var(--danger-border)] rounded-lg p-3 space-y-2">
          <p className="flex items-center gap-2 text-[var(--danger)] font-bold text-xs">
            <AlertTriangle className="w-4 h-4" /> {t('settings_critical_reset')}
          </p>
          <p className="text-[11px] text-[var(--text-muted)]">{t('settings_factory_desc')}</p>
          <button
            type="button"
            onClick={onFactoryReset}
            className="px-3 py-1.5 bg-[var(--danger)] hover:bg-[var(--danger-hover)] text-white rounded text-xs font-bold transition-all cursor-pointer"
          >
            {t('settings_factory_reset')}
          </button>
        </div>
      </div>
    </div>
  );
};
