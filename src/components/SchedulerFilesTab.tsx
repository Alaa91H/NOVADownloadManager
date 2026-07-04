import React from 'react';
import { Search, ShieldAlert, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { DownloadItem } from '../types/desktop-ui.types';

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
}) => {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="p-3 border border-[var(--border-color)] bg-[var(--bg-hover)]/10 rounded-xl flex items-center justify-between gap-3 mb-3 shrink-0">
        <div className="space-y-0.5 text-right">
          <div className="flex items-center gap-1.5">
            <h3 className="text-xs md:text-sm font-bold text-[var(--text-primary)]">
              {'Files of List:'} <span className="text-[var(--accent-primary)] font-mono">{name}</span>
            </h3>
            {isScheduled && (
              <span className="text-[9px] bg-emerald-500/15 border border-emerald-500/25 text-emerald-500 font-bold px-1.5 py-0.5 rounded flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                {`Schedule Active (${startTime} - ${endTime})`}
              </span>
            )}
          </div>
          <span className="text-[10px] text-[var(--text-muted)] font-bold">
            {'Total files:'} {filteredTasks.length}
          </span>
        </div>
      </div>

      <div className="px-3 py-2 bg-[var(--bg-hover)]/10 border border-[var(--border-color)] rounded-xl flex items-center gap-2 mb-3 shrink-0">
        <Search className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
        <input
          type="text"
          placeholder={'Search files...'}
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
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] font-semibold"
          >
            {'Clear Filter'}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 pr-1 pl-1">
        {filteredTasks.length === 0 ? (
          <div className="text-center py-16 text-[var(--text-muted)] space-y-2">
            <ShieldAlert className="w-10 h-10 mx-auto opacity-30 text-[var(--accent-primary)]" />
            <p className="font-bold text-xs text-[var(--text-secondary)]">
              {`No downloads customized for list [${name}] currently.`}
            </p>
            <p className="text-[11px] text-slate-500 max-w-xs mx-auto leading-relaxed">
              {'To assign a file to this list, edit its properties from the main table or select it when adding.'}
            </p>
          </div>
        ) : (
          filteredTasks.map((task, index) => {
            const percent = task.sizeBytes > 0 ? Math.round((task.downloadedBytes / task.sizeBytes) * 100) : 0;
            const sizeLabel = task.sizeBytes > 0 ? `${(task.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : 'Unknown';
            return (
              <div
                key={task.id}
                className="flex items-center justify-between p-3 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-color)] hover:border-[var(--accent-border)] rounded-xl shadow-sm gap-4"
              >
                <div className="flex items-center gap-3 truncate flex-1 min-w-0">
                  <span className="w-5 h-5 flex items-center justify-center bg-[var(--bg-input)] border border-[var(--border-color)] rounded-full text-[10px] font-mono text-[var(--text-secondary)] font-bold shrink-0">
                    {index + 1}
                  </span>
                  <div className="truncate text-right flex-1 min-w-0">
                    <span
                      className="text-xs font-bold font-mono block text-[var(--text-primary)] truncate"
                      style={{ direction: 'ltr' }}
                    >
                      {task.name}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)] block font-mono font-semibold truncate">
                      {`Size: ${sizeLabel} - Progress: ${String(percent)}%`}
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
                    className="p-1.5 bg-[var(--bg-input)] hover:bg-[var(--border-color)] disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-[var(--text-secondary)] hover:text-white cursor-pointer border-transparent"
                    title={'Move up'}
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onMoveDown(task.id);
                    }}
                    disabled={index === filteredTasks.length - 1}
                    className="p-1.5 bg-[var(--bg-input)] hover:bg-[var(--border-color)] disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-[var(--text-secondary)] hover:text-white cursor-pointer border-transparent"
                    title={'Move down'}
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  {taskToRemoveId === task.id ? (
                    <div className="flex items-center gap-1 bg-rose-500/10 border border-rose-500/20 p-1 rounded-lg">
                      <span className="text-[9px] font-bold text-rose-400 px-1 whitespace-nowrap">{'Remove?'}</span>
                      <button
                        type="button"
                        onClick={() => {
                          onRemoveConfirm(task.id);
                        }}
                        className="px-1.5 py-0.5 bg-rose-500 hover:bg-rose-600 text-white rounded text-[9px] font-bold cursor-pointer"
                      >
                        {'Yes'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onRemoveRequest(null);
                        }}
                        className="px-1.5 py-0.5 bg-[var(--bg-hover)] hover:bg-[var(--border-color)] text-[var(--text-primary)] rounded text-[9px] font-bold cursor-pointer"
                      >
                        {'No'}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        onRemoveRequest(task.id);
                      }}
                      className="p-1.5 bg-[var(--bg-input)] hover:bg-red-500/10 text-red-500 hover:text-red-400 rounded-lg cursor-pointer border-transparent"
                      title={'Remove file from this list'}
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
    </div>
  );
};
