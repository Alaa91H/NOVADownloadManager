import React, { useState } from 'react';
import {
  Search,
  ShieldAlert,
  ArrowUp,
  ArrowDown,
  Trash2,
  GripVertical,
  ChevronsUp,
  ChevronsDown,
  Info,
} from 'lucide-react';
import type { DownloadItem } from '../types/desktop-ui.types';
import type { ContextMenuOption } from './primitives/ContextMenu';
import { ContextMenu } from './primitives/ContextMenu';
import { useAppStore } from '../state/appStore';
import { formatBytes } from '../initialData';

const QUEUE_TASK_DRAG_TYPE = 'application/x-nova-queue-task';

interface SchedulerFilesTabProps {
  filteredTasks: DownloadItem[];
  name: string;
  isScheduled: boolean;
  startTime: string;
  endTime: string;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  taskToRemoveId: string | null;
  onRemoveRequest: (id: string | null) => void;
  onRemoveConfirm: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onMoveToEdge: (id: string, edge: 'top' | 'bottom') => void;
  onReorder: (draggedId: string, targetId: string) => void;
}

export const SchedulerFilesTab: React.FC<SchedulerFilesTabProps> = ({
  filteredTasks,
  name,
  isScheduled,
  startTime,
  endTime,
  searchQuery,
  onSearchChange,
  taskToRemoveId,
  onRemoveRequest,
  onRemoveConfirm,
  onMoveUp,
  onMoveDown,
  onMoveToEdge,
  onReorder,
}) => {
  const { t, openDialog } = useAppStore();

  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; task: DownloadItem } | null>(null);

  const buildContextMenuOptions = (task: DownloadItem): ContextMenuOption[] => {
    const index = filteredTasks.findIndex((item) => item.id === task.id);
    const options: ContextMenuOption[] = [
      {
        id: 'properties',
        label: t('nav_properties'),
        icon: <Info className="w-3.5 h-3.5" />,
        onClick: () => {
          openDialog('taskProperties', task);
        },
      },
    ];
    if (index > 0) {
      options.push(
        {
          id: 'moveTop',
          label: t('sched_menu_move_top'),
          icon: <ChevronsUp className="w-3.5 h-3.5" />,
          onClick: () => {
            onMoveToEdge(task.id, 'top');
          },
        },
        {
          id: 'moveUp',
          label: t('sched_prio_up'),
          icon: <ArrowUp className="w-3.5 h-3.5" />,
          onClick: () => {
            onMoveUp(task.id);
          },
        },
      );
    }
    if (index !== -1 && index < filteredTasks.length - 1) {
      options.push(
        {
          id: 'moveDown',
          label: t('sched_prio_down'),
          icon: <ArrowDown className="w-3.5 h-3.5" />,
          onClick: () => {
            onMoveDown(task.id);
          },
        },
        {
          id: 'moveBottom',
          label: t('sched_menu_move_bottom'),
          icon: <ChevronsDown className="w-3.5 h-3.5" />,
          onClick: () => {
            onMoveToEdge(task.id, 'bottom');
          },
        },
      );
    }
    options.push({
      id: 'removeFromList',
      label: t('sched_menu_remove'),
      icon: <Trash2 className="w-3.5 h-3.5" />,
      danger: true,
      onClick: () => {
        onRemoveConfirm(task.id);
      },
    });
    return options;
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="p-3 border border-[var(--border-color)] bg-[var(--bg-hover)]/10 rounded-xl flex items-center justify-between gap-3 mb-3 shrink-0">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5">
            <h3 className="text-xs md:text-sm font-bold text-[var(--text-primary)]">
              {t('sched_files_of_list')} <span className="text-[var(--accent-primary)] font-mono">{name}</span>
            </h3>
            {isScheduled && (
              <span className="text-[9px] bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success)] font-bold px-1.5 py-0.5 rounded flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]"></span>
                {t('sched_schedule_active', { start: startTime, end: endTime })}
              </span>
            )}
          </div>
          <span className="text-[10px] text-[var(--text-muted)] font-bold">
            {t('sched_total_files')} {filteredTasks.length}
          </span>
        </div>
        <span className="text-[10px] text-[var(--text-muted)] font-semibold hidden md:block">
          {t('sched_dnd_hint')}
        </span>
      </div>

      <div className="px-3 py-2 bg-[var(--bg-hover)]/10 border border-[var(--border-color)] rounded-xl flex items-center gap-2 mb-3 shrink-0">
        <Search className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
        <input
          type="text"
          placeholder={t('sched_search_placeholder')}
          value={searchQuery}
          onChange={(e) => {
            onSearchChange(e.target.value);
          }}
          className="w-full bg-transparent border-none text-xs text-[var(--text-primary)] focus:outline-none font-semibold"
        />
        {searchQuery && (
          <button
            onClick={() => {
              onSearchChange('');
            }}
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] font-semibold cursor-pointer"
          >
            {t('sched_clear_filter')}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 pr-1 pl-1">
        {filteredTasks.length === 0 ? (
          <div className="text-center py-16 text-[var(--text-muted)] space-y-2">
            <ShieldAlert className="w-10 h-10 mx-auto opacity-30 text-[var(--accent-primary)]" />
            <p className="font-bold text-xs text-[var(--text-secondary)]">{t('sched_empty_title', { name })}</p>
            <p className="text-[11px] text-[var(--text-muted)] max-w-xs mx-auto leading-relaxed">
              {t('sched_empty_desc')}
            </p>
          </div>
        ) : (
          filteredTasks.map((task, index) => {
            const percent = task.sizeBytes > 0 ? Math.round((task.downloadedBytes / task.sizeBytes) * 100) : 0;
            const sizeLabel = task.sizeBytes > 0 ? formatBytes(task.sizeBytes) : t('sched_size_unknown');
            const isDragging = draggedTaskId === task.id;
            const isDropTarget = dropTargetId === task.id && draggedTaskId !== task.id;
            return (
              <div
                key={task.id}
                draggable={!searchQuery}
                onDragStart={(e) => {
                  e.dataTransfer.setData(QUEUE_TASK_DRAG_TYPE, task.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDraggedTaskId(task.id);
                }}
                onDragOver={(e) => {
                  if (!draggedTaskId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDropTargetId(task.id);
                }}
                onDragLeave={() => {
                  setDropTargetId((prev) => (prev === task.id ? null : prev));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const draggedId = e.dataTransfer.getData(QUEUE_TASK_DRAG_TYPE) || draggedTaskId;
                  if (draggedId) {
                    onReorder(draggedId, task.id);
                  }
                  setDraggedTaskId(null);
                  setDropTargetId(null);
                }}
                onDragEnd={() => {
                  setDraggedTaskId(null);
                  setDropTargetId(null);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, task });
                }}
                className={`flex items-center justify-between p-3 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border rounded-xl shadow-sm gap-4 transition-all duration-150 ${
                  isDragging
                    ? 'opacity-40 border-dashed border-[var(--accent-primary)]'
                    : isDropTarget
                      ? 'border-[var(--accent-primary)] bg-[var(--accent-light)] scale-[1.01]'
                      : 'border-[var(--border-color)] hover:border-[var(--accent-border)]'
                }`}
              >
                <div className="flex items-center gap-3 truncate flex-1 min-w-0">
                  {!searchQuery && (
                    <GripVertical
                      className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 cursor-grab active:cursor-grabbing"
                      aria-hidden="true"
                    />
                  )}
                  <span className="w-5 h-5 flex items-center justify-center bg-[var(--bg-input)] border border-[var(--border-color)] rounded-full text-[10px] font-mono text-[var(--text-secondary)] font-bold shrink-0">
                    {index + 1}
                  </span>
                  <div className="truncate text-left flex-1 min-w-0">
                    <span
                      className="text-xs font-bold font-mono block text-[var(--text-primary)] truncate"
                      style={{ direction: 'ltr' }}
                    >
                      {task.name}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)] block font-mono font-semibold truncate">
                      {t('sched_size_progress', { size: sizeLabel, percent })}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      onMoveUp(task.id);
                    }}
                    disabled={index === 0}
                    className="p-1.5 bg-[var(--bg-input)] hover:bg-[var(--border-color)] disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer border-transparent transition-all duration-150 hover:scale-[1.05] active:scale-[0.95]"
                    title={t('sched_prio_up')}
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onMoveDown(task.id);
                    }}
                    disabled={index === filteredTasks.length - 1}
                    className="p-1.5 bg-[var(--bg-input)] hover:bg-[var(--border-color)] disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer border-transparent transition-all duration-150 hover:scale-[1.05] active:scale-[0.95]"
                    title={t('sched_prio_down')}
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  {taskToRemoveId === task.id ? (
                    <div className="flex items-center gap-1 bg-[var(--danger-bg)] border border-[var(--danger-border)] p-1 rounded-lg">
                      <span className="text-[9px] font-bold text-[var(--danger)] px-1 whitespace-nowrap">
                        {t('sched_remove_confirm')}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          onRemoveConfirm(task.id);
                        }}
                        className="px-1.5 py-0.5 bg-[var(--danger)] hover:bg-[var(--danger-hover)] text-white rounded text-[9px] font-bold cursor-pointer"
                      >
                        {t('sched_yes')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onRemoveRequest(null);
                        }}
                        className="px-1.5 py-0.5 bg-[var(--bg-hover)] hover:bg-[var(--border-color)] text-[var(--text-primary)] rounded text-[9px] font-bold cursor-pointer"
                      >
                        {t('sched_no')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        onRemoveRequest(task.id);
                      }}
                      className="p-1.5 bg-[var(--bg-input)] hover:bg-[var(--danger-bg)] text-[var(--danger)] hover:text-[var(--danger)] rounded-lg cursor-pointer border-transparent transition-all duration-150 hover:scale-[1.05] active:scale-[0.95]"
                      title={t('sched_menu_remove')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          options={buildContextMenuOptions(contextMenu.task)}
          onClose={() => {
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
};
