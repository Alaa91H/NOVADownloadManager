import React from 'react';
import { ExternalLink, FolderOpen } from 'lucide-react';
import { DownloadItem } from '../types/desktop-ui.types';
import { formatBytes } from '../initialData';
import { formatSpeed, formatTimeLeft } from '../utils/taskTableUtils';
import TaskCheckboxAndIcon from './primitives/TaskCheckboxAndIcon';
import { StatusPill } from './primitives';

interface TaskCardListProps {
  tasks: DownloadItem[];
  selectedTaskId: string | null;
  checkedTaskIds: Set<string>;
  setSelectedTaskId: (id: string | null) => void;
  handleToggleCheckTask: (id: string, e: React.MouseEvent) => void;
  startRowPress: (taskId: string, e: React.MouseEvent | React.TouchEvent) => void;
  endRowPress: (taskId: string, e: React.MouseEvent | React.TouchEvent, onSelect?: (id: string) => void) => void;
  cancelRowPress: () => void;
  pauseTask: (id: string) => void;
  resumeTask: (id: string) => void;
  openTaskFile: (id: string) => Promise<void>;
  openTaskLocation: (id: string) => Promise<void>;
  openDialog: (active: string, payload?: unknown) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const TaskCardList: React.FC<TaskCardListProps> = ({
  tasks,
  selectedTaskId,
  checkedTaskIds,
  setSelectedTaskId,
  handleToggleCheckTask,
  startRowPress,
  endRowPress,
  cancelRowPress,
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
      {tasks.map((task) => {
        const progressPercent = task.sizeBytes > 0 ? Math.round((task.downloadedBytes / task.sizeBytes) * 100) : 0;
        const isSelected = selectedTaskId === task.id;
        const isChecked = checkedTaskIds.has(task.id);

        return (
          <div
            key={task.id}
            onMouseDown={(e) => {
              startRowPress(task.id, e);
            }}
            onMouseUp={(e) => {
              endRowPress(task.id, e, setSelectedTaskId);
            }}
            onMouseLeave={cancelRowPress}
            onTouchStart={(e) => {
              startRowPress(task.id, e);
            }}
            onTouchEnd={(e) => {
              endRowPress(task.id, e, setSelectedTaskId);
            }}
            onTouchMove={cancelRowPress}
            className={`p-3 rounded-lg border transition-all cursor-pointer select-none ${
              isSelected
                ? 'bg-[var(--bg-selected)] border-[var(--accent-primary)] shadow-sm'
                : 'bg-[var(--bg-sidebar)] border-[var(--border-color)] hover:bg-[var(--bg-hover)]'
            } ${isChecked ? 'bg-[var(--accent-primary)]/5 border-[var(--accent-primary)]' : ''}`}
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
              <StatusPill status={task.status} />
            </div>

            <div className="mt-3 flex items-center gap-2">
              <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden border border-[var(--border-color)]">
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
              <span>Size: {formatBytes(task.sizeBytes)}</span>
              {task.status === 'downloading' && (
                <span className="text-emerald-500 font-bold">Speed: {formatSpeed(task.speedBytesPerSec)}</span>
              )}
              {task.status === 'downloading' && (
                <span className="text-blue-400">Left: {formatTimeLeft(task.timeLeftSeconds)}</span>
              )}
            </div>

            <div className="mt-3 pt-2.5 border-t border-[var(--border-color)] flex justify-end items-center gap-1.5">
              {task.status === 'downloading' ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    pauseTask(task.id);
                  }}
                  className="px-2 py-1 text-[10px] font-semibold bg-rose-500/10 border border-rose-500/20 text-rose-500 rounded hover:bg-rose-500/20 transition-all cursor-pointer"
                >
                  {t('topbar_stop')}
                </button>
              ) : task.status === 'paused' || task.status === 'error' ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    resumeTask(task.id);
                  }}
                  className="px-2 py-1 text-[10px] font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 rounded hover:bg-emerald-500/20 transition-all cursor-pointer"
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
                    className="h-7 w-7 inline-flex items-center justify-center bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 rounded hover:bg-emerald-500/20 transition-all cursor-pointer"
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
                    className="h-7 w-7 inline-flex items-center justify-center bg-blue-500/10 border border-blue-500/20 text-blue-500 rounded hover:bg-blue-500/20 transition-all cursor-pointer"
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
                className="px-2 py-1 text-[10px] font-semibold bg-red-500/10 border border-red-500/20 text-red-500 rounded hover:bg-red-500/20 transition-all cursor-pointer"
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

export default TaskCardList;
