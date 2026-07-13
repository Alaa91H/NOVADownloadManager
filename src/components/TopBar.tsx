/* src/components/TopBar.tsx */
import React from 'react';
import {
  Plus,
  Layers,
  Play,
  Square,
  Trash2,
  Settings,
  Search,
  Clock,
  Globe,
  Video,
  ChevronDown,
  CheckCircle2,
  Bell,
  Send,
} from 'lucide-react';
import { useAppStore } from '../state/appStore';
import { useEngineCapabilities } from '../capabilities/EngineCapabilityContext';
import { CustomButtonAction, CustomButtonIcon, ToolbarButtonId } from '../types/desktop-ui.types';
import { novaClient } from '../api/novaClient';

type DropdownId = 'newDownload' | 'resume' | 'stop' | 'delete' | null;

export const TopBar: React.FC = () => {
  const {
    selectedTaskId,
    tasks,
    pauseTask,
    resumeTask,
    deleteTask,
    searchQuery,
    setSearchQuery,
    openDialog,
    addToast,
    settings,
    updateSettings,
    isNotificationsMuted,
    setIsNotificationsMuted,
    isDegradedMode,
    t,
  } = useAppStore();

  const caps = useEngineCapabilities();

  const selectedTask = tasks.find((t) => t.id === selectedTaskId);

  const hasSelectedTask = !!(selectedTaskId && selectedTask);

  const canResumeSelected =
    !!selectedTask &&
    (selectedTask.status === 'paused' || selectedTask.status === 'error' || selectedTask.status === 'queued');

  const canStopSelected = !!selectedTask && selectedTask.status === 'downloading';

  const toolbarButtonVisible = (id: ToolbarButtonId) => settings.ui.toolbar[id].display !== 'hidden';
  const toolbarShowsIcon = (id: ToolbarButtonId) => settings.ui.toolbar[id].display !== 'labelOnly';
  const toolbarShowsLabel = (id: ToolbarButtonId) => settings.ui.toolbar[id].display !== 'iconOnly';
  const toolbarShowsDropdown = (id: ToolbarButtonId) => settings.ui.toolbar[id].showDropdown;

  const renderButtonContent = (
    id: ToolbarButtonId,
    icon: React.ReactNode,
    label: string,
    labelClassName = 'hidden md:inline',
  ) => (
    <>
      {toolbarShowsIcon(id) && icon}
      {toolbarShowsLabel(id) && <span className={labelClassName}>{label}</span>}
    </>
  );

  const handleResumeAll = () => {
    const inactive = tasks.filter((t) => t.status === 'paused' || t.status === 'queued');
    if (inactive.length === 0) {
      addToast('info', t('topbar_resume_all_title'), t('topbar_resume_all_none'));
      return;
    }
    inactive.forEach((t) => {
      resumeTask(t.id);
    });
    addToast('success', t('topbar_resume_all_title'), t('topbar_resume_all_done', { count: inactive.length }));
  };

  const handleStopAll = () => {
    const active = tasks.filter((t) => t.status === 'downloading');
    if (active.length === 0) {
      addToast('info', t('topbar_stop_all_title'), t('topbar_stop_all_none'));
      return;
    }
    active.forEach((t) => {
      pauseTask(t.id);
    });
    addToast('warning', t('topbar_stop_all_title'), t('topbar_stop_all_done', { count: active.length }));
  };

  const handleDeleteAll = async () => {
    if (tasks.length === 0) {
      addToast('info', t('topbar_delete_all_title'), t('topbar_delete_all_none'));
      return;
    }
    const ids = tasks.map((t) => t.id);
    for (const id of ids) {
      await deleteTask(id, false);
    }
    addToast('warning', t('topbar_delete_all_title'), t('topbar_delete_all_done', { count: ids.length }));
  };

  const handleDeleteCompleted = async () => {
    const completed = tasks.filter((t) => t.status === 'completed');
    if (completed.length === 0) {
      addToast('info', t('topbar_delete_completed_title'), t('topbar_delete_completed_none'));
      return;
    }
    for (const task of completed) {
      await deleteTask(task.id, false);
    }
    addToast(
      'warning',
      t('topbar_delete_completed_title'),
      t('topbar_delete_completed_done', { count: completed.length }),
    );
  };

  const toggleSpeedLimiter = () => {
    const updated = structuredClone(settings);
    updated.connection.speedLimiter.enabled = !updated.connection.speedLimiter.enabled;
    updateSettings(updated);
  };

  const sendSelectedToTelegram = async () => {
    if (!selectedTask || selectedTask.status !== 'completed' || !selectedTask.savePath) {
      addToast('warning', t('telegram_send_file_title'), t('telegram_send_file_no_file'));
      return;
    }
    try {
      const result = await novaClient.sendTelegramFile({
        path: selectedTask.savePath,
        caption: `NOVA: ${selectedTask.name}`,
      });
      if (result.ok) {
        addToast('success', t('telegram_send_file_title'), t('telegram_send_file_ok'));
      } else {
        addToast('error', t('telegram_send_file_title'), result.error || t('telegram_send_file_failed'));
      }
    } catch (error) {
      addToast(
        'error',
        t('telegram_send_file_title'),
        error instanceof Error ? error.message : t('telegram_send_file_failed'),
      );
    }
  };

  const confirmDeleteAll = () => {
    openDialog('genericConfirm', {
      message: t('topbar_delete_all_confirm'),
      isDanger: true,
      onConfirm: () => {
        void handleDeleteAll();
      },
    });
  };

  const confirmDeleteCompleted = () => {
    openDialog('genericConfirm', {
      message: t('topbar_delete_completed_confirm'),
      isDanger: true,
      onConfirm: () => {
        void handleDeleteCompleted();
      },
    });
  };

  const customIconMap: Record<CustomButtonIcon, React.ReactNode> = {
    plus: <Plus className="w-4 h-4 text-[var(--accent-primary)]" />,
    layers: <Layers className="w-4 h-4 text-sky-500" />,
    play: <Play className="w-4 h-4 text-emerald-500" />,
    stop: <Square className="w-3.5 h-3.5 text-rose-500 fill-rose-500/20" />,
    trash: <Trash2 className="w-4 h-4 text-red-500" />,
    settings: <Settings className="w-4 h-4 text-[var(--text-secondary)]" />,
    telegram: <Send className="w-4 h-4 text-sky-400" />,
    bell: <Bell className="w-4 h-4 text-amber-500" />,
    clock: <Clock className="w-4 h-4 text-amber-500" />,
    globe: <Globe className="w-4 h-4 text-indigo-400" />,
    video: <Video className="w-4 h-4 text-red-500" />,
  };

  const runCustomAction = (action: CustomButtonAction) => {
    switch (action) {
      case 'addDownload':
        openDialog('addDownload');
        break;
      case 'batchDownload':
        if (!caps.directReady) {
          addToast(
            'warning',
            t('engine_direct_unavailable'),
            caps.directBlockedReason() || t('engine_unavailable_desc'),
          );
          break;
        }
        openDialog('batchDownload');
        break;
      case 'webpageGrabber':
        if (!caps.mediaReady) {
          addToast('warning', t('engine_media_unavailable'), caps.mediaBlockedReason() || t('engine_unavailable_desc'));
          break;
        }
        openDialog('webpageGrabber');
        break;
      case 'youtubeDownload':
        if (!caps.mediaReady) {
          addToast('warning', t('engine_media_unavailable'), caps.mediaBlockedReason() || t('engine_unavailable_desc'));
          break;
        }
        openDialog('youtubeDownload');
        break;
      case 'resumeAll':
        handleResumeAll();
        break;
      case 'stopAll':
        handleStopAll();
        break;
      case 'deleteAll':
        confirmDeleteAll();
        break;
      case 'deleteCompleted':
        confirmDeleteCompleted();
        break;
      case 'openSettings':
        openDialog('settings');
        break;
      case 'openScheduler':
        openDialog('scheduler');
        break;
      case 'toggleNotifications':
        setIsNotificationsMuted(!isNotificationsMuted);
        break;
      case 'toggleSpeedLimiter':
        toggleSpeedLimiter();
        break;
      case 'sendSelectedToTelegram':
        void sendSelectedToTelegram();
        break;
      default:
        break;
    }
  };

  const [openDropdown, setOpenDropdown] = React.useState<DropdownId>(null);

  const toggleDropdown = (id: DropdownId) => {
    setOpenDropdown((prev) => (prev === id ? null : id));
  };

  const closeDropdown = () => {
    setOpenDropdown(null);
  };

  return (
    <header className="bg-[var(--bg-sidebar)] border-b border-[var(--border-color)] p-2 flex flex-nowrap items-center justify-between gap-3 select-none text-ui shrink-0 relative z-30">
      {/* LEFT: Toolbar actions */}
      <div className="flex flex-nowrap items-center gap-1.5 shrink-0">
        {/* Action: Unified Add Task Button with Dropdown (Split Button Pattern) */}
        {toolbarButtonVisible('newDownload') && (
          <div className="relative">
            <div className="flex items-stretch rounded-lg bg-[var(--accent-primary)] hover:scale-[1.03] active:scale-[0.97] transition-all duration-150 shadow-md accent-glow select-none shrink-0 overflow-hidden">
              <button
                onClick={() => {
                  if (!caps.directReady && !caps.mediaReady) {
                    addToast('warning', t('engine_no_engine'), caps.error || t('engine_unavailable_desc'));
                    return;
                  }
                  openDialog('addDownload');
                }}
                disabled={isDegradedMode || (!caps.directReady && !caps.mediaReady)}
                className="px-3 py-1.5 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white font-extrabold transition-all cursor-pointer flex items-center gap-1.5 text-xs border-r border-white/15 disabled:opacity-40 disabled:cursor-not-allowed"
                title={
                  isDegradedMode
                    ? t('statusbar_degraded_desc')
                    : !caps.directReady && !caps.mediaReady
                      ? caps.loading
                        ? t('engine_caps_loading')
                        : caps.error || t('engine_no_engine')
                      : t('topbar_new_download_tip')
                }
              >
                {renderButtonContent(
                  'newDownload',
                  <Plus className="w-3.5 h-3.5 stroke-[3]" />,
                  t('topbar_new_download'),
                  '',
                )}
              </button>

              {toolbarShowsDropdown('newDownload') && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleDropdown('newDownload');
                  }}
                  data-dialog-trigger="true"
                  className="px-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white transition-all cursor-pointer flex items-center justify-center"
                  title={t('topbar_more_options')}
                >
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform duration-200 ${openDropdown === 'newDownload' ? 'rotate-180' : ''}`}
                  />
                </button>
              )}
            </div>

            {toolbarShowsDropdown('newDownload') && openDropdown === 'newDownload' && (
              <>
                <div className="fixed inset-0 z-40 bg-transparent" onClick={closeDropdown} />
                <div className="absolute top-full left-0 mt-1.5 w-64 bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-lg shadow-xl p-1.5 z-50 animate-in fade-in slide-in-from-top-1 duration-100 flex flex-col gap-0.5">
                  <button
                    onClick={() => {
                      openDialog('addDownload');
                      closeDropdown();
                    }}
                    disabled={!caps.directReady && !caps.mediaReady}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                    title={
                      !caps.directReady && !caps.mediaReady
                        ? caps.loading
                          ? t('engine_caps_loading')
                          : caps.error || t('engine_no_engine')
                        : ''
                    }
                  >
                    <Plus className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>{t('topbar_single_url')}</span>
                  </button>
                  <button
                    onClick={() => {
                      openDialog('batchDownload');
                      closeDropdown();
                    }}
                    disabled={!caps.directReady}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                    title={
                      !caps.directReady
                        ? caps.loading
                          ? t('engine_caps_loading')
                          : caps.directBlockedReason() || t('engine_direct_unavailable')
                        : ''
                    }
                  >
                    <Layers className="w-4 h-4 text-sky-500 shrink-0" />
                    <span>{t('topbar_batch_download')}</span>
                  </button>
                  <button
                    onClick={() => {
                      openDialog('webpageGrabber');
                      closeDropdown();
                    }}
                    disabled={!caps.mediaReady}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                    title={
                      !caps.mediaReady
                        ? caps.loading
                          ? t('engine_caps_loading')
                          : caps.mediaBlockedReason() || t('engine_media_unavailable')
                        : ''
                    }
                  >
                    <Globe className="w-4 h-4 text-indigo-400 shrink-0" />
                    <span>{t('dlg_webpage_grabber')}</span>
                  </button>
                  <button
                    onClick={() => {
                      openDialog('youtubeDownload');
                      closeDropdown();
                    }}
                    disabled={!caps.mediaReady}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                    title={
                      !caps.mediaReady
                        ? caps.loading
                          ? t('engine_caps_loading')
                          : caps.mediaBlockedReason() || t('engine_media_unavailable')
                        : ''
                    }
                  >
                    <Video className="w-4 h-4 text-red-500 shrink-0" />
                    <span>{t('dlg_media_downloader')}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {!caps.loading && caps.error && !isDegradedMode && (
          <span
            className="px-1.5 py-0.5 text-[9px] font-bold bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded whitespace-nowrap max-w-[160px] truncate cursor-default"
            title={caps.error}
          >
            {t('topbar_engine_error')}
          </span>
        )}

        <div className="h-5 w-px bg-[var(--border-color)] mx-1 shrink-0" />

        {/* Action: Resume (Split Button) */}
        {toolbarButtonVisible('resume') && (
          <div className="relative">
            <div className="flex items-stretch rounded-lg border border-[var(--border-color)] hover:border-emerald-500/20 hover:bg-emerald-500/5 hover:scale-[1.03] active:scale-[0.97] transition-all duration-150 overflow-hidden shrink-0">
              <button
                onClick={() => {
                  if (canResumeSelected && selectedTaskId) {
                    resumeTask(selectedTaskId);
                  } else {
                    handleResumeAll();
                  }
                }}
                disabled={isDegradedMode}
                className="px-3 py-1.5 text-[var(--text-secondary)] hover:text-emerald-400 hover:bg-emerald-500/10 transition-all cursor-pointer flex items-center gap-1 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                title={isDegradedMode ? t('statusbar_degraded_desc') : hasSelectedTask ? t('topbar_resume_selected_tip') : t('topbar_resume_all_tip')}
              >
                {renderButtonContent(
                  'resume',
                  <Play className="w-4 h-4 text-emerald-500 fill-emerald-500/20" />,
                  t('resume'),
                )}
              </button>
              {toolbarShowsDropdown('resume') && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleDropdown('resume');
                  }}
                  className="px-1.5 text-[var(--text-secondary)] hover:text-emerald-400 hover:bg-emerald-500/10 transition-all cursor-pointer flex items-center justify-center border-l border-[var(--border-color)]"
                  title={t('topbar_resume_options')}
                  aria-label={t('topbar_resume_options')}
                >
                  <ChevronDown
                    className={`w-3 h-3 transition-transform duration-200 ${openDropdown === 'resume' ? 'rotate-180' : ''}`}
                  />
                </button>
              )}
            </div>

            {toolbarShowsDropdown('resume') && openDropdown === 'resume' && (
              <>
                <div className="fixed inset-0 z-40 bg-transparent" onClick={closeDropdown} />
                <div className="absolute top-full left-0 mt-1.5 w-52 bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-lg shadow-xl p-1.5 z-50 animate-in fade-in slide-in-from-top-1 duration-100 flex flex-col gap-0.5">
                  <button
                    onClick={() => {
                      if (canResumeSelected && selectedTaskId) resumeTask(selectedTaskId);
                      closeDropdown();
                    }}
                    disabled={!canResumeSelected}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Play className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>{t('topbar_resume_selected')}</span>
                  </button>
                  <button
                    onClick={() => {
                      handleResumeAll();
                      closeDropdown();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                  >
                    <Play className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>{t('topbar_resume_all')}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Action: Stop (Split Button) */}
        {toolbarButtonVisible('stop') && (
          <div className="relative">
            <div className="flex items-stretch rounded-lg border border-[var(--border-color)] hover:border-rose-500/20 hover:bg-rose-500/5 hover:scale-[1.03] active:scale-[0.97] transition-all duration-150 overflow-hidden shrink-0">
              <button
                onClick={() => {
                  if (canStopSelected && selectedTaskId) {
                    pauseTask(selectedTaskId);
                  } else {
                    handleStopAll();
                  }
                }}
                disabled={isDegradedMode}
                className="px-3 py-1.5 text-[var(--text-secondary)] hover:text-rose-400 hover:bg-rose-500/10 transition-all cursor-pointer flex items-center gap-1 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                title={isDegradedMode ? t('statusbar_degraded_desc') : hasSelectedTask ? t('topbar_stop_selected_tip') : t('topbar_stop_all_tip')}
              >
                {renderButtonContent(
                  'stop',
                  <Square className="w-3.5 h-3.5 text-rose-500 fill-rose-500/20" />,
                  t('topbar_stop'),
                )}
              </button>
              {toolbarShowsDropdown('stop') && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleDropdown('stop');
                  }}
                  className="px-1.5 text-[var(--text-secondary)] hover:text-rose-400 hover:bg-rose-500/10 transition-all cursor-pointer flex items-center justify-center border-l border-[var(--border-color)]"
                  title={t('topbar_stop_options')}
                  aria-label={t('topbar_stop_options')}
                >
                  <ChevronDown
                    className={`w-3 h-3 transition-transform duration-200 ${openDropdown === 'stop' ? 'rotate-180' : ''}`}
                  />
                </button>
              )}
            </div>

            {toolbarShowsDropdown('stop') && openDropdown === 'stop' && (
              <>
                <div className="fixed inset-0 z-40 bg-transparent" onClick={closeDropdown} />
                <div className="absolute top-full left-0 mt-1.5 w-52 bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-lg shadow-xl p-1.5 z-50 animate-in fade-in slide-in-from-top-1 duration-100 flex flex-col gap-0.5">
                  <button
                    onClick={() => {
                      if (canStopSelected && selectedTaskId) pauseTask(selectedTaskId);
                      closeDropdown();
                    }}
                    disabled={!canStopSelected}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Square className="w-4 h-4 text-rose-500 shrink-0" />
                    <span>{t('topbar_stop_selected')}</span>
                  </button>
                  <button
                    onClick={() => {
                      handleStopAll();
                      closeDropdown();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                  >
                    <Square className="w-4 h-4 text-rose-400 shrink-0" />
                    <span>{t('topbar_stop_all')}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Action: Delete (Split Button) */}
        {toolbarButtonVisible('delete') && (
          <div className="relative">
            <div className="flex items-stretch rounded-lg border border-[var(--border-color)] hover:border-red-500/20 hover:bg-red-500/5 hover:scale-[1.03] active:scale-[0.97] transition-all duration-150 overflow-hidden shrink-0">
              <button
                onClick={() => {
                  if (hasSelectedTask) {
                    openDialog('confirmDelete', selectedTask);
                  } else if (tasks.length > 0) {
                    openDialog('genericConfirm', {
                      message: t('topbar_delete_all_confirm'),
                      isDanger: true,
                      onConfirm: () => {
                        void handleDeleteAll();
                      },
                    });
                  }
                }}
                disabled={isDegradedMode}
                className="px-3 py-1.5 text-red-500 hover:text-red-400 hover:bg-red-500/10 transition-all cursor-pointer flex items-center gap-1 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                title={isDegradedMode ? t('statusbar_degraded_desc') : hasSelectedTask ? t('topbar_delete_selected_tip') : t('topbar_delete_all_tip')}
              >
                {renderButtonContent('delete', <Trash2 className="w-4 h-4" />, t('action_delete'))}
              </button>
              {toolbarShowsDropdown('delete') && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleDropdown('delete');
                  }}
                  className="px-1.5 text-red-500 hover:text-red-400 hover:bg-red-500/10 transition-all cursor-pointer flex items-center justify-center border-l border-[var(--border-color)]"
                  title={t('topbar_delete_options')}
                  aria-label={t('topbar_delete_options')}
                >
                  <ChevronDown
                    className={`w-3 h-3 transition-transform duration-200 ${openDropdown === 'delete' ? 'rotate-180' : ''}`}
                  />
                </button>
              )}
            </div>

            {toolbarShowsDropdown('delete') && openDropdown === 'delete' && (
              <>
                <div className="fixed inset-0 z-40 bg-transparent" onClick={closeDropdown} />
                <div className="absolute top-full left-0 mt-1.5 w-56 bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-lg shadow-xl p-1.5 z-50 animate-in fade-in slide-in-from-top-1 duration-100 flex flex-col gap-0.5">
                  <button
                    onClick={() => {
                      if (hasSelectedTask) openDialog('confirmDelete', selectedTask);
                      closeDropdown();
                    }}
                    disabled={!hasSelectedTask}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-4 h-4 text-red-500 shrink-0" />
                    <span>{t('topbar_delete_selected')}</span>
                  </button>
                  <button
                    onClick={() => {
                      openDialog('genericConfirm', {
                        message: t('topbar_delete_all_confirm'),
                        isDanger: true,
                        onConfirm: () => {
                          void handleDeleteAll();
                        },
                      });
                      closeDropdown();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                  >
                    <Trash2 className="w-4 h-4 text-red-400 shrink-0" />
                    <span>{t('topbar_delete_all')}</span>
                  </button>
                  <button
                    onClick={() => {
                      openDialog('genericConfirm', {
                        message: t('topbar_delete_completed_confirm'),
                        isDanger: true,
                        onConfirm: () => {
                          void handleDeleteCompleted();
                        },
                      });
                      closeDropdown();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                  >
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>{t('topbar_delete_completed')}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="h-5 w-px bg-[var(--border-color)] mx-1 shrink-0" />

        {/* Action: Scheduler / Organiser */}
        {toolbarButtonVisible('scheduler') && (
          <button
            onClick={() => {
              openDialog('scheduler');
            }}
            data-dialog-trigger="true"
            className="px-3 py-1.5 border border-[var(--border-color)] rounded-lg text-[var(--text-secondary)] hover:text-amber-400 hover:border-amber-500/20 hover:bg-amber-500/10 transition-all cursor-pointer flex items-center gap-1 text-xs font-bold shrink-0 hover:scale-[1.03] active:scale-[0.97] duration-150"
            title={t('topbar_scheduler_tip')}
          >
            {renderButtonContent(
              'scheduler',
              <Clock className="w-4 h-4 text-amber-500" />,
              t('nav_queues'),
              'hidden sm:inline',
            )}
          </button>
        )}

        {settings.ui.customButtons
          .filter((button) => button.enabled)
          .map((button) => (
            <button
              key={button.id}
              type="button"
              onClick={() => {
                runCustomAction(button.action);
              }}
              className="px-3 py-1.5 border border-[var(--border-color)] rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-color-hover)] hover:bg-[var(--bg-hover)] transition-all cursor-pointer flex items-center gap-1 text-xs font-bold shrink-0 hover:scale-[1.03] active:scale-[0.97] duration-150"
              title={button.label}
            >
              {button.display !== 'labelOnly' && customIconMap[button.icon]}
              {button.display !== 'iconOnly' && <span className="hidden sm:inline">{button.label}</span>}
            </button>
          ))}
      </div>

      {/* RIGHT: Search Query Input bar & Settings icon */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Settings Button */}
        <button
          onClick={() => {
            openDialog('settings');
          }}
          data-dialog-trigger="true"
          className="p-1.5 hover:bg-[var(--bg-hover)] rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all duration-150 hover:scale-[1.05] active:scale-[0.95] cursor-pointer shrink-0"
          title={t('nav_settings')}
        >
          <Settings className="w-4.5 h-4.5" />
        </button>

        {/* Search Input */}
        <div className="relative w-48 sm:w-60">
          <Search className="absolute right-2.5 top-2.5 w-3.5 h-3.5 text-[var(--text-muted)]" />
          <input
            data-global-search="true"
            type="text"
            placeholder={t('topbar_search_placeholder')}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg py-1.5 pr-8 pl-3 text-xs focus:outline-none focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)] text-[var(--text-primary)] font-medium"
          />
        </div>
      </div>
    </header>
  );
};
