/* src/dialogs/common/ConfirmDialog.tsx */
import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { Checkbox, DialogButton } from '../../components/primitives';
import { DownloadItem } from '../../types/desktop-ui.types';

export const ConfirmDialog: React.FC = () => {
  const { dialog, closeDialog, deleteTask, t } = useAppStore();
  const [deleteDisk, setDeleteDisk] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const payload = dialog.payload;
  const task: DownloadItem | null =
    payload &&
    typeof payload === 'object' &&
    'id' in (payload as Record<string, unknown>) &&
    'name' in (payload as Record<string, unknown>)
      ? (payload as DownloadItem)
      : null;

  if (!task) {
    return (
      <div className="text-center p-4">
        <p className="text-red-500 text-xs">{t('confirm_item_not_found')}</p>
        <DialogButton onClick={closeDialog} variant="secondary" className="mt-2">
          {t('btn_close')}
        </DialogButton>
      </div>
    );
  }

  const handleConfirm = async () => {
    setIsDeleting(true);
    try {
      await deleteTask(task.id, deleteDisk);
      closeDialog();
    } catch {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-3.5">
      <p className="text-xs text-[var(--text-primary)] font-medium leading-relaxed">{t('confirm_remove_download')}</p>

      <div className="space-y-2">
        <div
          className="text-[11px] text-[var(--text-secondary)] bg-[var(--bg-hover)] p-2 border border-[var(--border-color)] rounded font-mono text-left truncate"
          style={{ direction: 'ltr' }}
          title={task.name}
        >
          {task.name}
        </div>

        <Checkbox label={t('confirm_delete_disk')} checked={deleteDisk} onChange={setDeleteDisk} disabled={isDeleting} />
      </div>

      <div className="flex justify-end gap-2 pt-3 border-t border-[var(--border-color)]">
        <DialogButton
          onClick={() => {
            void handleConfirm();
          }}
          variant="danger"
          icon={Trash2}
          disabled={isDeleting}
        >
          {isDeleting ? t('confirm_deleting') : t('action_delete')}
        </DialogButton>
        <DialogButton onClick={closeDialog} variant="ghost" disabled={isDeleting}>
          {t('btn_cancel')}
        </DialogButton>
      </div>
    </div>
  );
};
