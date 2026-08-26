/* src/dialogs/download/DownloadCompletedDialog.tsx */
import React, { useMemo, useState } from 'react';
import { CheckCircle2, FileText, FolderOpen } from 'lucide-react';
import type { DownloadItem } from '../../types/desktop-ui.types';
import {
  useDialogActions,
  useDialogData,
  useI18n,
  useSettingsActions,
  useSettingsData,
  useTaskActions,
  useTaskData,
} from '../../store/selectors';
import { Button, DialogButton } from '../../components/primitives';

/**
 * An explicit, actionable completion surface.  It intentionally owns only the
 * "show this again" preference: opening the file/location remains a task-store
 * operation so its validation and error feedback stay consistent everywhere.
 */
export const DownloadCompletedDialog: React.FC = () => {
  const { payload } = useDialogData();
  const tasks = useTaskData();
  const { openTaskFile, openTaskLocation } = useTaskActions();
  const settings = useSettingsData();
  const { updateSettings } = useSettingsActions();
  const { closeDialog } = useDialogActions();
  const t = useI18n();
  const [doNotShowAgain, setDoNotShowAgain] = useState(false);

  const payloadTask = payload as DownloadItem | null | undefined;
  const task = useMemo(
    () => (payloadTask?.id ? tasks.find((candidate) => candidate.id === payloadTask.id) || payloadTask : null),
    [payloadTask, tasks],
  );

  const persistPreference = () => {
    if (!doNotShowAgain || !settings.extra.showCompletionDialog) return;
    updateSettings(
      {
        ...settings,
        extra: {
          ...settings.extra,
          showCompletionDialog: false,
        },
      },
      true,
    );
  };

  const closeWithPreference = () => {
    persistPreference();
    closeDialog();
  };

  const handleOpenFile = async () => {
    if (!task) return;
    persistPreference();
    closeDialog();
    await openTaskFile(task.id);
  };

  const handleOpenLocation = async () => {
    if (!task) return;
    persistPreference();
    closeDialog();
    await openTaskLocation(task.id);
  };

  if (!task) return null;

  return (
    <div className="space-y-4 text-start text-ui" data-testid="download-completed-dialog">
      <div className="flex gap-3 rounded-xl border border-[var(--success-border)] bg-[var(--success-bg)] p-4">
        <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-[var(--success)]" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-extrabold text-[var(--text-primary)]">{t('download_complete_message')}</p>
          <p className="mt-1 break-words text-xs font-semibold text-[var(--text-secondary)]">{task.name}</p>
          {task.savePath ? (
            <p
              className="mt-2 break-all rounded bg-[var(--bg-input)] px-2 py-1 font-mono text-[10px] text-[var(--text-muted)]"
              dir="ltr"
            >
              {task.savePath}
            </p>
          ) : null}
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-hover)]/30 px-3 py-2.5 text-xs text-[var(--text-primary)]">
        <input
          type="checkbox"
          checked={doNotShowAgain}
          onChange={(event) => {
            setDoNotShowAgain(event.target.checked);
          }}
          className="h-4 w-4 cursor-pointer rounded border-[var(--border-color)] bg-[var(--bg-input)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)]"
        />
        <span>{t('download_complete_do_not_show_again')}</span>
      </label>

      <div className="flex flex-col-reverse gap-2 border-t border-[var(--border-color)] pt-4 sm:flex-row sm:justify-end">
        <DialogButton type="button" variant="secondary" onClick={closeWithPreference}>
          {t('progress_close')}
        </DialogButton>
        <Button type="button" variant="secondary" onClick={() => void handleOpenLocation()} icon={FolderOpen}>
          {t('menu_open_file_location')}
        </Button>
        <Button type="button" variant="primary" onClick={() => void handleOpenFile()} icon={FileText}>
          {t('menu_open_file')}
        </Button>
      </div>
    </div>
  );
};
