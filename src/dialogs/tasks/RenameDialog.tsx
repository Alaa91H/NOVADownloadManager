/* src/dialogs/tasks/RenameDialog.tsx */
import React, { useState } from 'react';
import { FileEdit, AlertCircle } from 'lucide-react';
import { useDialogData, useDialogActions, useTaskActions, useI18n } from '../../store/selectors';
import { TextField, DialogButton } from '../../components/primitives';
import type { DownloadItem } from '../../types/desktop-ui.types';

export const RenameDialog: React.FC = () => {
  const dialog = useDialogData();
  const { closeDialog } = useDialogActions();
  const { renameTask } = useTaskActions();
  const t = useI18n();

  const task = dialog.payload as DownloadItem | undefined;
  const [newName, setNewName] = useState(task?.name || '');
  const [busy, setBusy] = useState(false);

  if (!task) {
    return (
      <div className="text-center p-4">
        <p className="text-[var(--danger)] text-xs">{t('task_no_selection')}</p>
        <DialogButton onClick={closeDialog} variant="secondary" className="mt-2">
          {t('btn_close')}
        </DialogButton>
      </div>
    );
  }

  const trimmed = newName.trim();
  const invalidChars = /[/\\:*?"<>|]/;
  const isValid = trimmed.length > 0 && !invalidChars.test(trimmed) && trimmed !== '.' && trimmed !== '..';

  const handleRename = async () => {
    if (!isValid || busy) return;
    setBusy(true);
    const ok = await renameTask(task.id, trimmed);
    setBusy(false);
    if (ok) closeDialog();
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3 bg-[var(--bg-hover)] p-3 rounded-lg border border-[var(--border-color)]/30">
        <AlertCircle className="w-5 h-5 text-[var(--info)] shrink-0 mt-0.5" />
        <div className="text-xs space-y-1">
          <p className="font-extrabold text-[var(--text-primary)]">{t('rename_title')}</p>
          <p className="text-[var(--text-secondary)] leading-relaxed">{t('rename_desc')}</p>
        </div>
      </div>

      <div
        className="text-[11px] text-[var(--text-secondary)] bg-[var(--bg-hover)] p-2 border border-[var(--border-color)] rounded font-mono text-left truncate"
        style={{ direction: 'ltr' }}
        title={task.name}
      >
        {task.name}
      </div>

      <TextField
        label={t('rename_new_name')}
        id="rename-download"
        icon={FileEdit}
        value={newName}
        onChange={(e) => {
          setNewName(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            void handleRename();
          }
        }}
        placeholder=""
        className="font-mono text-xs pr-9 pl-3 text-left"
        autoFocus
      />
      {!isValid && trimmed.length > 0 && (
        <p className="text-[10px] text-[var(--danger)] font-bold">{t('rename_invalid_chars')}</p>
      )}

      <div className="flex justify-end gap-2 pt-3 border-t border-[var(--border-color)]">
        <DialogButton onClick={closeDialog} variant="secondary">
          {t('btn_cancel')}
        </DialogButton>
        <DialogButton
          onClick={() => {
            void handleRename();
          }}
          variant="primary"
          icon={FileEdit}
          disabled={!isValid || busy}
        >
          {t('rename_btn')}
        </DialogButton>
      </div>
    </div>
  );
};
