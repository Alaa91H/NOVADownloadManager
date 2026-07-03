/* src/dialogs/common/ConfirmDialog.tsx */
import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { Checkbox, DialogButton } from '../../components/primitives';
import { DownloadItem } from '../../types/desktop-ui.types';

export const ConfirmDialog: React.FC = () => {
  const { dialog, closeDialog, deleteTask, t } = useAppStore();
  const [deleteDisk, setDeleteDisk] = useState(false);
  const task: DownloadItem = dialog.payload;

  if (!task) {
    return (
      <div className="text-center p-4">
        <p className="text-red-500 text-xs">The download item was not found.</p>
        <DialogButton onClick={closeDialog} variant="secondary" className="mt-2">{t('btn_close')}</DialogButton>
      </div>
    );
  }

  const handleConfirm = () => {
    deleteTask(task.id, deleteDisk);
    closeDialog();
  };

  return (
    <div className="space-y-3.5">
      <p className="text-xs text-[var(--text-primary)] font-medium leading-relaxed">
        Remove this download from NOVA?
      </p>

      <div className="space-y-2">
        <div className="text-[11px] text-[var(--text-secondary)] bg-[var(--bg-hover)] p-2 border border-[var(--border-color)] rounded font-mono text-left truncate" style={{ direction: 'ltr' }} title={task.name}>
          {task.name}
        </div>

        <Checkbox
          label="Also delete the downloaded file from disk"
          checked={deleteDisk}
          onChange={setDeleteDisk}
        />
      </div>

      <div className="flex justify-end gap-2 pt-3 border-t border-[var(--border-color)]">
        <DialogButton onClick={handleConfirm} variant="danger" icon={Trash2}>
          Delete
        </DialogButton>
        <DialogButton onClick={closeDialog} variant="ghost">
          {t('btn_cancel')}
        </DialogButton>
      </div>
    </div>
  );
};
