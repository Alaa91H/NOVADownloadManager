import React from 'react';
import { Play, Pause, Trash2, ListPlus, Sliders } from 'lucide-react';
import { useAppStore } from '../state/appStore';
import { DownloadItem } from '../types/desktop-ui.types';
import { StatusPill } from './primitives';
import TaskCheckboxAndIcon from './primitives/TaskCheckboxAndIcon';
import TaskCardList from './TaskCardList';
import ColumnConfigPanel from './ColumnConfigPanel';
import { useColumnState } from '../hooks/useColumnState';
import { useMultiSelection } from '../hooks/useMultiSelection';
import { useTaskSortFilter } from '../hooks/useTaskSortFilter';
import { formatBytes } from '../initialData';
import {
  getColAlign,
  getFileTypeIcon,
  formatSpeed,
  formatTimeLeft,
  getSortField,
  renderSortIcon,
  SortColumn,
} from '../utils/taskTableUtils';

export const TaskTable: React.FC = () => {
  const {
    tasks, selectedTaskId, setSelectedTaskId, searchQuery, workspaceView,
    pauseTask, resumeTask, deleteTask, openDialog, t, addToast
  } = useAppStore();

  const {
    colWidths, visibleCols, colOrder, draggingCol,
    showColConfig, colConfigRef, visibleColsCount,
    setVisibleCols, setShowColConfig,
    startResize, handleDragStart, handleDragOver, handleDrop, handleDragEnd,
    handleCustomizeDragStart, handleCustomizeDragOver,
    handleCustomizeDrop, handleCustomizeDragEnd, draggingCustomizeCol,
  } = useColumnState();

  const { sortBy, sortOrder, sortedTasks, handleSort } = useTaskSortFilter(tasks, searchQuery, workspaceView);

  const {
    checkedTaskIds, isAllChecked, isSomeChecked,
    startRowPress, endRowPress, cancelRowPress,
    handleToggleCheckAll, handleToggleCheckTask, clearSelection,
  } = useMultiSelection(sortedTasks.map(t => t.id));

  const handleBatchResume = () => {
    checkedTaskIds.forEach(id => {
      const task = tasks.find(t => t.id === id);
      if (task && (task.status === 'paused' || task.status === 'error')) {
        resumeTask(id);
      }
    });
    clearSelection();
  };

  const handleBatchPause = () => {
    checkedTaskIds.forEach(id => {
      const task = tasks.find(t => t.id === id);
      if (task && task.status === 'downloading') {
        pauseTask(id);
      }
    });
    clearSelection();
  };

  const handleBatchDelete = () => {
    if (confirm(`Are you sure you want to delete ${checkedTaskIds.size} files from the download list?`)) {
      checkedTaskIds.forEach(id => deleteTask(id, false));
      clearSelection();
    }
  };

  const handleRowDoubleClick = (task: DownloadItem) => {
    setSelectedTaskId(task.id);
    if (task.status === 'downloading' || task.status === 'paused' || task.status === 'error') {
      openDialog('activeProgress', task);
    } else {
      openDialog('taskProperties', task);
    }
  };

  return (
    <div className="flex-1 bg-[var(--bg-app)] overflow-auto select-none relative">
      {/* Batch action bar */}
      {checkedTaskIds.size > 0 && (
        <div className="sticky top-0 z-30 px-3 py-2 bg-[var(--accent-primary)]/10 border-b border-[var(--accent-primary)]/20 flex items-center gap-2">
          <span className="text-xs font-bold text-[var(--accent-primary)]">{checkedTaskIds.size} selected</span>
          <div className="flex gap-1 ml-auto">
            <button onClick={handleBatchResume} className="px-2 py-1 text-[10px] font-bold bg-emerald-500/20 text-emerald-500 rounded hover:bg-emerald-500/30 transition-all cursor-pointer inline-flex items-center gap-1">
              <Play className="w-3 h-3" /> Resume
            </button>
            <button onClick={handleBatchPause} className="px-2 py-1 text-[10px] font-bold bg-amber-500/20 text-amber-500 rounded hover:bg-amber-500/30 transition-all cursor-pointer inline-flex items-center gap-1">
              <Pause className="w-3 h-3" /> Pause
            </button>
            <button onClick={handleBatchDelete} className="px-2 py-1 text-[10px] font-bold bg-red-500/20 text-red-500 rounded hover:bg-red-500/30 transition-all cursor-pointer inline-flex items-center gap-1">
              <Trash2 className="w-3 h-3" /> Delete
            </button>
          </div>
        </div>
      )}

      {/* Desktop Table View */}
      <table className="hidden md:table w-full border-collapse text-ui font-medium min-w-[800px] table-fixed">
        <colgroup>
          <col style={{ width: '32px', minWidth: '32px', maxWidth: '32px' }} />
          {colOrder.map(colKey => {
            if (!visibleCols[colKey]) return null;
            return <col key={colKey} style={{ width: `${colWidths[colKey] || 100}px` }} />;
          })}
          <col style={{ width: '48px', minWidth: '48px', maxWidth: '48px' }} />
        </colgroup>
        <thead>
          <tr className="desktop-table-header sticky top-0 z-10 text-xs text-[var(--text-secondary)] border-b border-[var(--border-color)] whitespace-nowrap">
            <th className="group/header px-1.5 py-2 text-center sticky ltr:left-0 rtl:right-0 z-20 bg-[var(--bg-app)]/80 backdrop-blur-md ltr:border-r rtl:border-l border-[var(--border-color)]" style={{ width: '32px', minWidth: '32px', maxWidth: '32px' }}>
              <div className="flex items-center justify-center min-h-[1.5rem]">
                <div className={`transition-all duration-100 ${checkedTaskIds.size > 0 ? 'block' : 'hidden group-hover/header:block'}`}>
                  <input
                    type="checkbox"
                    checked={isAllChecked}
                    ref={el => { if (el) el.indeterminate = isSomeChecked; }}
                    onChange={handleToggleCheckAll}
                    className="rounded-none border-[var(--border-color)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer h-3.5 w-3.5"
                  />
                </div>
                <div className={`transition-all duration-100 ${checkedTaskIds.size > 0 ? 'hidden' : 'block group-hover/header:hidden'}`}>
                  <ListPlus className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                </div>
              </div>
            </th>

            {colOrder.map(colKey => {
              if (!visibleCols[colKey]) return null;
              const sortField = getSortField(colKey);
              let arabicLabel: string;
              switch (colKey) {
                case 'name': arabicLabel = t('col_name'); break;
                case 'size': arabicLabel = t('col_size'); break;
                case 'progress': arabicLabel = t('col_progress'); break;
                case 'speed': arabicLabel = t('col_speed'); break;
                case 'timeLeft': arabicLabel = t('col_time_left'); break;
                case 'date': arabicLabel = t('col_date_added'); break;
                case 'status': arabicLabel = t('col_status'); break;
                case 'retries': arabicLabel = t('col_retries') || 'Retries'; break;
                case 'connections': arabicLabel = t('col_threads'); break;
                case 'crc32': arabicLabel = 'CRC32'; break;
                case 'priority': arabicLabel = t('col_priority'); break;
                case 'completedDate': arabicLabel = t('col_date_completed') || 'Completed Date'; break;
                case 'sourceUrl': arabicLabel = t('prop_url') || 'Source URL'; break;
                case 'smartCategory': arabicLabel = t('prop_type') || 'Smart Category'; break;
                default: arabicLabel = colKey;
              }
              return (
                <th
                  key={colKey}
                  draggable="true"
                  onDragStart={(e) => handleDragStart(e, colKey)}
                  onDragOver={(e) => handleDragOver(e, colKey)}
                  onDrop={(e) => handleDrop(e, colKey)}
                  onDragEnd={handleDragEnd}
                  onClick={() => handleSort(sortField)}
                  className={`px-3 py-2 cursor-grab active:cursor-grabbing hover:bg-[var(--bg-hover)] select-none relative font-bold border-r border-[var(--border-color)]/20 transition-all text-[var(--text-secondary)] ${getColAlign(colKey)} ${
                    draggingCol === colKey ? 'opacity-35 bg-[var(--bg-hover)] border-dashed border-[var(--accent-primary)]' : ''
                  }`}
                  style={{ width: colWidths[colKey] || 100 }}
                >
                  <span className="flex items-center justify-between w-full gap-2">
                    <span>{arabicLabel}</span>
                    {renderSortIcon(sortBy, sortOrder, sortField)}
                  </span>
                  <div
                    onMouseDown={(e) => startResize(colKey, e)}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[var(--accent-primary)] bg-transparent z-20"
                  />
                </th>
              );
            })}

            <th className="px-2 py-1 text-center sticky ltr:right-0 rtl:left-0 z-20 bg-[var(--bg-app)]/80 backdrop-blur-md ltr:border-l rtl:border-r border-[var(--border-color)]" style={{ width: '48px', minWidth: '48px', maxWidth: '48px' }}>
              <button
                onClick={(e) => { e.stopPropagation(); setShowColConfig(!showColConfig); }}
                className="p-1 hover:bg-[var(--bg-hover)] rounded-none text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all cursor-pointer inline-flex items-center justify-center"
                title="Customize columns"
              >
                <Sliders className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedTasks.length === 0 ? (
            <tr>
              <td colSpan={visibleColsCount} className="px-4 py-24 text-center text-[var(--text-muted)]">
                {t('no_downloads')}
              </td>
            </tr>
          ) : (
            sortedTasks.map(task => {
              const progressPercent = task.sizeBytes > 0 ? Math.round((task.downloadedBytes / task.sizeBytes) * 100) : 0;
              const isSelected = selectedTaskId === task.id;
              const isChecked = checkedTaskIds.has(task.id);

              return (
                <tr
                  key={task.id}
                  onDoubleClick={() => handleRowDoubleClick(task)}
                  onMouseDown={(e) => startRowPress(task.id, e)}
                  onMouseUp={(e) => endRowPress(task.id, e, setSelectedTaskId)}
                  onMouseLeave={cancelRowPress}
                  onTouchStart={(e) => startRowPress(task.id, e)}
                  onTouchEnd={(e) => endRowPress(task.id, e, setSelectedTaskId)}
                  onTouchMove={cancelRowPress}
                  className={`desktop-table-row border-b border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] whitespace-nowrap cursor-pointer transition-colors select-none ${
                    isSelected ? 'selected bg-[var(--bg-hover)]' : ''
                  } ${isChecked ? 'bg-[var(--accent-primary)]/5 border-r-2 border-r-[var(--accent-primary)]' : ''}`}
                >
                  <td className="px-1.5 py-1 text-center sticky ltr:left-0 rtl:right-0 z-10 bg-[var(--bg-app)]/90 backdrop-blur-md ltr:border-r rtl:border-l border-[var(--border-color)]" style={{ width: '32px', minWidth: '32px', maxWidth: '32px' }}>
                    <div className="flex items-center justify-center min-h-[1.5rem]">
                      <TaskCheckboxAndIcon
                        isChecked={isChecked}
                        fileType={task.fileType}
                        taskId={task.id}
                        handleToggleCheckTask={handleToggleCheckTask}
                        hasSelection={checkedTaskIds.size > 0}
                      />
                    </div>
                  </td>

                  {colOrder.map(colKey => {
                    if (!visibleCols[colKey]) return null;
                    const width = colWidths[colKey] || 100;

                    switch (colKey) {
                      case 'name':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-sans truncate text-left" style={{ width }}>
                            <span className="truncate text-[11px] font-semibold font-mono block text-left" style={{ direction: 'ltr' }} title={task.name}>
                              {task.name}
                            </span>
                          </td>
                        );
                      case 'size':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)] truncate text-start" style={{ width }}>
                            {formatBytes(task.sizeBytes)}
                          </td>
                        );
                      case 'progress':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-start" style={{ width }}>
                            <div className="flex items-center gap-1.5">
                              <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden border border-[var(--border-color)]">
                                <div
                                  className={`h-full bg-[var(--accent-primary)] rounded-full transition-all duration-300 ${task.status === 'downloading' ? 'accent-glow relative overflow-hidden' : ''}`}
                                  style={{ width: `${progressPercent}%` }}
                                >
                                  {task.status === 'downloading' && (
                                    <div className="absolute inset-0 bg-white/20 animate-pulse" />
                                  )}
                                </div>
                              </div>
                              <span className="text-[9px] text-[var(--text-secondary)] font-bold">{progressPercent}%</span>
                            </div>
                          </td>
                        );
                      case 'speed':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-emerald-500 font-bold truncate text-start" style={{ width }}>
                            {formatSpeed(task.speedBytesPerSec)}
                          </td>
                        );
                      case 'timeLeft':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-blue-400 truncate" style={{ width, textAlign: 'left' }}>
                            {formatTimeLeft(task.timeLeftSeconds)}
                          </td>
                        );
                      case 'date':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[10px] text-[var(--text-muted)] truncate" style={{ width, direction: 'ltr', textAlign: 'left' }}>
                            {task.dateAdded}
                          </td>
                        );
                      case 'status':
                        return (
                          <td key={colKey} className="px-2 py-0.5 truncate text-start" style={{ width }}>
                            <StatusPill status={task.status} />
                          </td>
                        );
                      case 'retries':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)] truncate text-start" style={{ width }}>
                            {task.status === 'error' ? '3' : '0'}
                          </td>
                        );
                      case 'connections':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)] truncate text-start" style={{ width }}>
                            {task.connections === 0 ? `Auto (${task.segments?.length || 8})` : task.connections}
                          </td>
                        );
                      case 'crc32':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[11px] text-indigo-400 font-semibold truncate text-start" style={{ width }}>
                            {task.status === 'completed' ? 'E89FA21B' : '--'}
                          </td>
                        );
                      case 'priority':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-sans text-[11px] truncate text-start" style={{ width }}>
                            <span className={`px-2 py-0.5 rounded-md text-[9px] font-bold ${
                              task.queueId === 'fast' ? 'bg-red-500/10 text-red-500 border border-red-500/20' :
                              task.queueId === 'night' ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20' :
                              'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                            }`}>
                              {task.queueId === 'fast' ? 'High' : task.queueId === 'night' ? 'Low' : 'Normal'}
                            </span>
                          </td>
                        );
                      case 'completedDate':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[10px] text-[var(--text-muted)] truncate" style={{ width, direction: 'ltr', textAlign: 'left' }}>
                            {task.status === 'completed' ? task.dateAdded : '--'}
                          </td>
                        );
                      case 'sourceUrl':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-mono text-[10px] text-[var(--text-muted)] truncate text-left" style={{ width, direction: 'ltr' }} title={task.url}>
                            {task.url}
                          </td>
                        );
                      case 'smartCategory':
                        return (
                          <td key={colKey} className="px-2 py-0.5 font-sans text-[11px] truncate text-start" style={{ width }}>
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-[var(--accent-light)] text-[var(--accent-primary)]">
                              {getFileTypeIcon(task.fileType, "w-3 h-3")}
                              <span>
                                {task.fileType === 'program' ? 'Programs' :
                                 task.fileType === 'compressed' ? 'Archives' :
                                 task.fileType === 'video' ? 'Video' :
                                 task.fileType === 'audio' ? 'Audio' :
                                 task.fileType === 'document' ? 'Documents' : 'Other'}
                              </span>
                            </span>
                          </td>
                        );
                      default:
                        return null;
                    }
                  })}

                  <td className="px-2 py-1 text-center bg-[var(--bg-app)]/90 backdrop-blur-md sticky ltr:right-0 rtl:left-0 z-10 ltr:border-l rtl:border-r border-[var(--border-color)]" style={{ width: '48px', minWidth: '48px', maxWidth: '48px' }} />
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {/* Mobile Card List View */}
      <TaskCardList
        tasks={sortedTasks}
        selectedTaskId={selectedTaskId}
        checkedTaskIds={checkedTaskIds}
        setSelectedTaskId={setSelectedTaskId}
        handleToggleCheckTask={handleToggleCheckTask}
        startRowPress={startRowPress}
        endRowPress={endRowPress}
        cancelRowPress={cancelRowPress}
        pauseTask={pauseTask}
        resumeTask={resumeTask}
        openDialog={openDialog}
        t={t}
      />

      {/* Column Config Panel */}
      {showColConfig && (
        <div ref={colConfigRef}>
          <ColumnConfigPanel
            colOrder={colOrder}
            visibleCols={visibleCols}
            draggingCustomizeCol={draggingCustomizeCol}
            setVisibleCols={setVisibleCols}
            handleCustomizeDragStart={handleCustomizeDragStart}
            handleCustomizeDragOver={handleCustomizeDragOver}
            handleCustomizeDrop={handleCustomizeDrop}
            handleCustomizeDragEnd={handleCustomizeDragEnd}
          />
        </div>
      )}
    </div>
  );
};
