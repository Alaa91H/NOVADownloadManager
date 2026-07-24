/* src/dialogs/tasks/UpdateLinkDialog.tsx */
import React, { useState } from 'react';
import { Globe, Link2, AlertCircle, FileEdit, ArrowRight } from 'lucide-react';
import { useDialogData, useDialogActions, useTaskActions, useToastActions, useI18n } from '../../store/selectors';
import { TextField, DialogButton } from '../../components/primitives';
import type { DownloadItem } from '../../types/desktop-ui.types';

export const UpdateLinkDialog: React.FC = () => {
  const dialog = useDialogData();
  const { closeDialog } = useDialogActions();
  const { refreshTaskLink } = useTaskActions();
  const { addToast } = useToastActions();
  const t = useI18n();

  const task = dialog.payload as DownloadItem | undefined;
  const [mode, setMode] = useState<'browser' | 'manual'>('browser');
  const [newUrl, setNewUrl] = useState(task?.url || '');
  const [busy, setBusy] = useState(false);

  if (!task) {
    return (
      <div className="text-center p-4">
        <p className="text-[var(--danger)] text-xs">{t('update_link_no_selection')}</p>
        <DialogButton onClick={closeDialog} variant="secondary" className="mt-2">
          {t('btn_close')}
        </DialogButton>
      </div>
    );
  }

  const handleUpdateManual = async () => {
    const url = newUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      addToast('error', t('toast_error_title'), t('update_link_error_toast'));
      return;
    }
    if (busy) return;
    setBusy(true);
    const ok = await refreshTaskLink(task.id, url);
    setBusy(false);
    if (ok) {
      addToast('success', t('toast_success_title'), t('update_link_success_toast'));
      closeDialog();
    }
  };

  const handleStartBrowserUpdate = () => {
    const targetUrl = task.referer || task.url;
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
    addToast('info', t('toast_info_title'), t('update_link_info_toast'));
    setMode('manual');
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3 bg-[var(--bg-hover)] p-3 rounded-lg border border-[var(--border-color)]/30">
        <AlertCircle className="w-5 h-5 text-[var(--info)] shrink-0 mt-0.5" />
        <div className="text-xs space-y-1">
          <p className="font-extrabold text-[var(--text-primary)]">{t('update_link_title')}</p>
          <p className="text-[var(--text-secondary)] leading-relaxed">{t('update_link_desc')}</p>
        </div>
      </div>

      <div className="flex bg-[var(--bg-input)] p-1 rounded-lg border border-[var(--border-color)]/50">
        <button
          onClick={() => {
            setMode('browser');
          }}
          className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-xs font-bold transition-all cursor-pointer ${
            mode === 'browser'
              ? 'bg-[var(--accent-primary)] text-white shadow-sm'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          }`}
        >
          <Globe className="w-4 h-4" />
          <span>{t('update_link_open_source')}</span>
        </button>
        <button
          onClick={() => {
            setMode('manual');
          }}
          className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-xs font-bold transition-all cursor-pointer ${
            mode === 'manual'
              ? 'bg-[var(--accent-primary)] text-white shadow-sm'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          }`}
        >
          <FileEdit className="w-4 h-4" />
          <span>{t('update_link_paste')}</span>
        </button>
      </div>

      <div className="space-y-3 bg-[var(--bg-hover)]/20 p-3 rounded-lg border border-[var(--border-color)]/30">
        <div>
          <label className="text-[11px] text-[var(--text-secondary)] font-bold block mb-1">
            {t('update_link_current_file')}
          </label>
          <div className="bg-[var(--bg-input)]/80 text-[var(--text-primary)] px-3 py-1.5 rounded border border-[var(--border-color)]/30 text-xs font-mono font-bold truncate">
            {task.name}
          </div>
        </div>

        <div>
          <label className="text-[11px] text-[var(--text-secondary)] font-bold block mb-1">
            {t('update_link_current_link')}
          </label>
          <div
            className="bg-[var(--bg-input)]/50 text-[var(--text-muted)] px-3 py-1.5 rounded border border-[var(--border-color)]/30 text-[10px] font-mono truncate select-all"
            style={{ direction: 'ltr' }}
          >
            {task.url}
          </div>
        </div>
      </div>

      {mode === 'browser' ? (
        <div className="bg-[var(--success-bg)] border border-[var(--success-border)] p-4 rounded-lg space-y-3">
          <p className="text-xs text-[var(--success)] dark:text-[var(--success)] font-medium leading-relaxed">
            {t('update_link_browser_desc')}
          </p>
          <div className="flex justify-end pt-1">
            <button
              onClick={handleStartBrowserUpdate}
              className="px-4 py-2.5 bg-[var(--success)] hover:bg-[var(--success-hover)] text-white font-bold text-xs rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm"
            >
              <Globe className="w-4 h-4" />
              <span>{t('update_link_open_page')}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 animate-in fade-in duration-200">
          <TextField
            label={t('update_link_new_link')}
            id="new-url"
            icon={Link2}
            value={newUrl}
            onChange={(e) => {
              setNewUrl(e.target.value);
            }}
            placeholder=""
            className="font-mono text-xs pr-9 pl-3 text-left"
            autoFocus
          />
          <div className="flex justify-end gap-2 pt-2">
            <DialogButton onClick={closeDialog} variant="secondary">
              {t('btn_cancel')}
            </DialogButton>
            <DialogButton
              onClick={() => {
                void handleUpdateManual();
              }}
              variant="primary"
              icon={Globe}
            >
              {t('update_link_update_btn')}
            </DialogButton>
          </div>
        </div>
      )}
    </div>
  );
};
