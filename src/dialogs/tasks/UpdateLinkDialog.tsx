/* src/dialogs/tasks/UpdateLinkDialog.tsx */
import React, { useState } from 'react';
import { Globe, Link2, AlertCircle, FileEdit, ArrowRight } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { TextField, DialogButton } from '../../components/primitives';
import { DownloadItem } from '../../types/desktop-ui.types';

export const UpdateLinkDialog: React.FC = () => {
  const { dialog, closeDialog, updateTaskProperties, addToast, t } = useAppStore();

  const task = dialog.payload as DownloadItem | undefined;
  const [mode, setMode] = useState<'browser' | 'manual'>('browser');
  const [newUrl, setNewUrl] = useState(task?.url || '');

  if (!task) {
    return (
      <div className="text-center p-4">
        <p className="text-red-500 text-xs">No file was selected for link renewal.</p>
        <DialogButton onClick={closeDialog} variant="secondary" className="mt-2">
          {t('btn_close')}
        </DialogButton>
      </div>
    );
  }

  const handleUpdateManual = () => {
    const url = newUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      addToast('error', t('toast_error_title'), 'Enter a valid direct download link (http:// or https://).');
      return;
    }

    updateTaskProperties(task.id, { url });
    addToast('success', 'Link Updated', 'The download link was updated successfully.');
    closeDialog();
  };

  const handleStartBrowserUpdate = () => {
    const targetUrl = task.referer || task.url;
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
    addToast('info', 'Source Page Opened', 'Copy the new direct link from your browser and paste it here.');
    setMode('manual');
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3 bg-[var(--bg-hover)] p-3 rounded-lg border border-[var(--border-color)]/30">
        <AlertCircle className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />
        <div className="text-xs space-y-1">
          <p className="font-extrabold text-[var(--text-primary)]">Update Download Link</p>
          <p className="text-[var(--text-secondary)] leading-relaxed">
            If a temporary direct link expired, open the source page or paste a fresh direct link manually.
          </p>
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
          <span>Open Source Page</span>
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
          <span>Paste Link</span>
        </button>
      </div>

      <div className="space-y-3 bg-[var(--bg-hover)]/20 p-3 rounded-lg border border-[var(--border-color)]/30">
        <div>
          <label className="text-[11px] text-[var(--text-secondary)] font-bold block mb-1">Current File</label>
          <div className="bg-[var(--bg-input)]/80 text-[var(--text-primary)] px-3 py-1.5 rounded border border-[var(--border-color)]/30 text-xs font-mono font-bold truncate">
            {task.name}
          </div>
        </div>

        <div>
          <label className="text-[11px] text-[var(--text-secondary)] font-bold block mb-1">Current Link</label>
          <div
            className="bg-[var(--bg-input)]/50 text-[var(--text-muted)] px-3 py-1.5 rounded border border-[var(--border-color)]/30 text-[10px] font-mono truncate select-all"
            style={{ direction: 'ltr' }}
          >
            {task.url}
          </div>
        </div>
      </div>

      {mode === 'browser' ? (
        <div className="bg-emerald-500/5 border border-emerald-500/20 p-4 rounded-lg space-y-3">
          <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium leading-relaxed">
            NOVA will open the source page in your system browser. Paste the renewed direct link in the manual tab
            afterward.
          </p>
          <div className="flex justify-end pt-1">
            <button
              onClick={handleStartBrowserUpdate}
              className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm"
            >
              <Globe className="w-4 h-4" />
              <span>Open Page</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 animate-in fade-in duration-200">
          <TextField
            label="New Direct Download Link"
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
            <DialogButton onClick={handleUpdateManual} variant="primary" icon={Globe}>
              Update Link
            </DialogButton>
          </div>
        </div>
      )}

      {mode === 'browser' && (
        <div className="flex justify-end pt-1">
          <DialogButton onClick={closeDialog} variant="secondary">
            {t('btn_close')}
          </DialogButton>
        </div>
      )}
    </div>
  );
};
