import React from 'react';
import { ExternalLink, FolderOpen } from 'lucide-react';
import type { DownloadItem } from '../types/desktop-ui.types';
import { formatBytes } from '../initialData';
import { formatSpeed, formatTimeLeft, formatElapsed } from '../utils/taskTableUtils';
import TaskCheckboxAndIcon from './primitives/TaskCheckboxAndIcon';
import { StatusPill } from './primitives';

interface TaskCardListProps {
  tasks: DownloadItem[];
  checkedTaskIds: Set<string>;
  handleToggleCheckTask: (id: string, e: React.MouseEvent) => void;
  pauseTask: (id: string) => void;
  resumeTask: (id: string) => void;
  openTaskFile: (id: string) => Promise<void>;
  openTaskLocation: (id: string) => Promise<void>;
  openDialog: (active: string, payload?: unknown) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const TaskCardListInner: React.FC<TaskCardListProps> = ({
  tasks,
  checkedTaskIds,
  handleToggleCheckTask,
  pauseTask,
  resumeTask,
  openTaskFile,
  openTaskLocation,
  openDialog,
  t,
}) => {
  if (tasks.length === 0) {
    return (
      <div className="md:hidden p-3 space-y-3">
        <div className="py-12 text-center text-[var(--text-muted)] text-xs">{t('no_downloads')}</div>
      </div>
    );
  }

  return (
    <div className="md:hidden p-3 space-y-3">
      {/* VIRTUAL SCROLLING: For mobile card view with 100+ tasks, wrap the
          card list in react-virtuoso's Virtuoso component with fixed-height
          rows (~140px per card). This keeps DOM node count constant. */}
      {tasks.map((task) => {
        const progressPercent = task.sizeBytes > 0 ? Math.round((task.downloadedBytes / task.sizeBytes) * 100) : 0;
        const isChecked = checkedTaskIds.has(task.id);

        return (
          <div
            key={task.id}
            className={`p-3 rounded-lg border transition-all cursor-default select-none bg-[var(--bg-sidebar)] border-[var(--border-color)] ${
              isChecked ? 'bg-[var(--accent-primary)]/5 border-[var(--accent-primary)]' : 'hover:bg-[var(--bg-hover)]'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <TaskCheckboxAndIcon
                  isChecked={isChecked}
                  fileType={task.fileType}
                  taskId={task.id}
                  handleToggleCheckTask={handleToggleCheckTask}
                  hasSelection={checkedTaskIds.size > 0}
                />
                <span
                  className="font-bold text-xs truncate max-w-[180px] text-[var(--text-primary)] font-mono text-left"
                  style={{ direction: 'ltr' }}
                >
                  {task.name}
                </span>
              </div>
              <StatusPill status={task.status} engineStatus={task.engineStatus} errorMessage={task.errorMessage} />
            </div>

            <div className="mt-3 flex items-center gap-2">
              <div className="flex-1 h-2 bg-[var(--bg-surface)] dark:bg-[var(--bg-surface-elevated)] rounded-full overflow-hidden border border-[var(--border-color)]">
                <div
                  className={`h-full bg-[var(--accent-primary)] rounded-full transition-all duration-300 ${task.status === 'downloading' ? 'accent-glow relative overflow-hidden' : ''}`}
                  style={{ width: `${String(progressPercent)}%` }}
                >
                  {task.status === 'downloading' && <div className="absolute inset-0 bg-white/20 animate-pulse" />}
                </div>
              </div>
              <span className="text-[10px] text-[var(--text-secondary)] font-mono font-bold">{progressPercent}%</span>
            </div>

            <div className="mt-2.5 flex flex-wrap justify-between text-[10px] text-[var(--text-secondary)] font-mono">
              <span>
                {t('table_size_label')} {formatBytes(task.sizeBytes)}
              </span>
              {task.status === 'downloading' && (
                <span className="text-[var(--success)] font-bold">
                  {t('table_speed_label')} {formatSpeed(task.speedBytesPerSec)}
                </span>
              )}
              {task.status === 'downloading' && (
                <span className="text-[var(--info)]">
                  {t('table_left_label')} {formatTimeLeft(task.timeLeftSeconds)}
                </span>
              )}
              <span className="text-[var(--warning)]">
                {t('table_elapsed_label')} {formatElapsed(task.elapsedSeconds)}
              </span>
            </div>

            <div className="mt-3 pt-2.5 border-t border-[var(--border-color)] flex justify-end items-center gap-1.5">
              {task.status === 'downloading' ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    pauseTask(task.id);
                  }}
                  className="px-2 py-1 text-[10px] font-semibold bg-[var(--danger-bg)] border border-[var(--danger-border)] text-[var(--danger)] rounded hover:bg-[var(--danger-bg)] transition-all cursor-pointer"
                >
                  {t('topbar_stop')}
                </button>
              ) : task.status === 'paused' || task.status === 'error' ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    resumeTask(task.id);
                  }}
                  className="px-2 py-1 text-[10px] font-semibold bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success)] rounded hover:bg-[var(--success-bg)] transition-all cursor-pointer"
                >
                  {t('resume')}
                </button>
              ) : null}
              {task.status === 'completed' && (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void openTaskFile(task.id);
                    }}
                    className="h-7 w-7 inline-flex items-center justify-center bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success)] rounded hover:bg-[var(--success-bg)] transition-all cursor-pointer"
                    title={t('menu_open_file')}
                    aria-label={t('menu_open_file')}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void openTaskLocation(task.id);
                    }}
                    className="h-7 w-7 inline-flex items-center justify-center bg-[var(--info-bg)] border border-[var(--info-border)] text-[var(--info)] rounded hover:bg-[var(--info-bg)] transition-all cursor-pointer"
                    title={t('menu_open_file_location')}
                    aria-label={t('menu_open_file_location')}
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openDialog('taskProperties', task);
                }}
                className="px-2 py-1 text-[10px] font-semibold bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-secondary)] rounded hover:text-[var(--text-primary)] transition-all cursor-pointer"
              >
                {t('properties')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openDialog('confirmDelete', task);
                }}
                className="px-2 py-1 text-[10px] font-semibold bg-[var(--danger-bg)] border border-[var(--danger-border)] text-[var(--danger)] rounded hover:bg-[var(--danger-bg)] transition-all cursor-pointer"
              >
                {t('action_delete')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const TaskCardList = React.memo(TaskCardListInner);
export default TaskCardList;
