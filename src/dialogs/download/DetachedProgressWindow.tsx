/* src/dialogs/download/DetachedProgressWindow.tsx */
import React, { useEffect, lazy, Suspense } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, X } from 'lucide-react';
import { logger } from '../../utils/logger';
import { useTaskData, useBridgeData, useI18n } from '../../store/selectors';
import { Logo } from '../../components/Logo';
import { taskProgressInfo } from '../../utils/progressUtils';
import { TaskProgressBar } from '../../components/primitives/TaskProgressBar';

const ActiveProgressDialog = lazy(() =>
  import('./ActiveProgressDialog').then((m) => ({ default: m.ActiveProgressDialog })),
);

/**
 * Full-window host for a single download's live progress, shown in a separate
 * OS window that can be moved anywhere outside the main app frame. It shares
 * the app store, so task data, pause/resume and speed limits stay live via the
 * same daemon connection the primary window uses.
 */
export const DetachedProgressWindow: React.FC<{ taskId: string }> = ({ taskId }) => {
  const tasks = useTaskData();
  const bridge = useBridgeData();
  const t = useI18n();
  const task = tasks.find((tt) => tt.id === taskId);
  // Live progress for the bound task — same single helper used by every other
  // renderer, so the title bar shows the same honest indeterminate→percent
  // behaviour as the bars inside the dialog.
  const progress = taskProgressInfo(task);

  const minimize = () => {
    if (isTauri())
      void getCurrentWindow()
        .minimize()
        .catch((e: unknown) => {
          logger.warn('DetachedProgressWindow', 'minimize failed', e);
        });
  };
  const close = () => {
    if (isTauri())
      void getCurrentWindow()
        .close()
        .catch((e: unknown) => {
          logger.warn('DetachedProgressWindow', 'close failed', e);
        });
  };

  // Keep the OS window title in sync with the file being downloaded; include
  // the live percentage so the taskbar/title can be read at a glance.
  useEffect(() => {
    if (!isTauri()) return;
    const title = task
      ? `${progress.indeterminate ? '…' : `${String(progress.percent)}%`} — ${task.name}`
      : t('app_name');
    void getCurrentWindow()
      .setTitle(title)
      .catch((e: unknown) => {
        logger.warn('DetachedProgressWindow', 'setTitle failed', e);
      });
  }, [task, progress.indeterminate, progress.percent, t]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
      {/* Custom draggable title bar */}
      <div
        data-tauri-drag-region
        className="bg-[var(--bg-sidebar)] h-8 px-2 flex items-center justify-between select-none shrink-0 border-b border-[var(--border-color)]"
        style={{ direction: 'ltr' }}
      >
        <div data-tauri-drag-region className="flex items-center gap-2 min-w-0">
          <Logo size={16} />
          <span className="text-[11px] font-bold text-[var(--text-primary)] truncate">
            {task ? task.name : t('app_name')}
          </span>
          {task && (
            <>
              <span className="text-[10px] font-mono font-bold text-[var(--accent-primary)] shrink-0">
                {progress.percentLabel}
              </span>
              {/* Compact live bar — same cross-fade component as every surface. */}
              <div className="w-20 shrink-0" data-tauri-drag-region>
                <TaskProgressBar
                  progress={progress}
                  active={task.status === 'downloading'}
                  trackClass="h-1"
                  showLabel={false}
                  ariaLabel={task.name}
                />
              </div>
            </>
          )}
        </div>
        <div className="flex items-center h-full">
          <button
            onClick={minimize}
            className="h-full px-3 hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center cursor-pointer"
            title={t('win_minimize')}
          >
            <Minus className="w-3 h-3 text-[var(--text-secondary)]" />
          </button>
          <button
            onClick={close}
            className="h-full px-3 hover:bg-[var(--danger)] hover:text-white transition-colors flex items-center justify-center cursor-pointer"
            title={t('btn_close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Live progress content */}
      <div className="flex-1 overflow-y-auto p-3 bg-[var(--bg-surface-elevated)]">
        {bridge.status === 'connecting' ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--text-secondary)]">
            <Logo size={40} className="animate-pulse opacity-80" />
            <p className="text-xs">{t('shell_connecting')}</p>
          </div>
        ) : task ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <div className="w-6 h-6 border-2 border-[var(--accent-primary)] border-t-transparent rounded-full animate-spin" />
              </div>
            }
          >
            <ActiveProgressDialog taskId={taskId} />
          </Suspense>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <p className="text-xs text-[var(--danger)]">{t('task_no_selection')}</p>
          </div>
        )}
      </div>
    </div>
  );
};
