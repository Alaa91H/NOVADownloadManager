/* src/dialogs/common/GenericConfirmDialog.tsx */
import React from 'react';
import { AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { useDialogData, useDialogActions, useI18n } from '../../store/selectors';
import { DialogButton } from '../../components/primitives';

export const GenericConfirmDialog: React.FC = () => {
  const dialog = useDialogData();
  const { closeDialog } = useDialogActions();
  const t = useI18n();
  const {
    message,
    onConfirm,
    isDanger = false,
  } = (dialog.payload || {}) as { message?: string; onConfirm?: () => void; isDanger?: boolean };

  const handleConfirm = () => {
    if (onConfirm) onConfirm();
    closeDialog();
  };

  return (
    <div className="space-y-4 text-right" dir="auto">
      <div
        className={`flex items-center gap-3 p-3 rounded-lg border ${isDanger ? 'bg-[var(--danger-bg)] border-[var(--danger-border)] text-[var(--danger)]' : 'bg-[var(--info-bg)] border-[var(--info-border)] text-[var(--info)]'}`}
      >
        {isDanger ? <AlertTriangle className="w-6 h-6 shrink-0" /> : <Info className="w-6 h-6 shrink-0" />}
        <p className="text-xs font-bold">{message}</p>
      </div>

      <div className="flex justify-end gap-2 pt-4 border-t border-[var(--border-color)]">
        <DialogButton onClick={handleConfirm} variant={isDanger ? 'danger' : 'primary'} icon={CheckCircle}>
          {t('btn_confirm')}
        </DialogButton>
        <DialogButton onClick={closeDialog} variant="ghost">
          {t('btn_cancel')}
        </DialogButton>
      </div>
    </div>
  );
};
