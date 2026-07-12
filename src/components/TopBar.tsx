/* src/components/TopBar.tsx */
import React, { useEffect, useState } from 'react';
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
import type { CustomButtonAction, CustomButtonIcon, ToolbarButtonId } from '../types/desktop-ui.types';
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
    t,
  } = useAppStore();

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
    let deleted = 0;
    for (const id of ids) {
      try {
        await deleteTask(id, false);
        deleted++;
      } catch { /* continue with remaining tasks */ }
    }
    addToast('warning', t('topbar_delete_all_title'), t('topbar_delete_all_done', { count: deleted }));
  };

  const handleDeleteCompleted = async () => {
    const completed = tasks.filter((t) => t.status === 'completed');
    if (completed.length === 0) {
      addToast('info', t('topbar_delete_completed_title'), t('topbar_delete_completed_none'));
      return;
    }
    let deleted = 0;
    for (const task of completed) {
      try {
        await deleteTask(task.id, false);
        deleted++;
      } catch { /* continue with remaining tasks */ }
    }
    addToast(
      'warning',
      t('topbar_delete_completed_title'),
      t('topbar_delete_completed_done', { count: deleted }),
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
    layers: <Layers className="w-4 h-4 text-[var(--info)]" />,
    play: <Play className="w-4 h-4 text-[var(--success)]" />,
    stop: <Square className="w-3.5 h-3.5 text-[var(--danger)] fill-[var(--danger-bg)]" />,
    trash: <Trash2 className="w-4 h-4 text-[var(--danger)]" />,
    settings: <Settings className="w-4 h-4 text-[var(--text-secondary)]" />,
    telegram: <Send className="w-4 h-4 text-[var(--info)]" />,
    bell: <Bell className="w-4 h-4 text-[var(--warning)]" />,
    clock: <Clock className="w-4 h-4 text-[var(--warning)]" />,
    globe: <Globe className="w-4 h-4 text-[var(--info)]" />,
    video: <Video className="w-4 h-4 text-[var(--danger)]" />,
  };

  const runCustomAction = (action: CustomButtonAction) => {
    switch (action) {
      case 'addDownload':
        openDialog('addDownload');
        break;
      case 'batchDownload':
        openDialog('batchDownload');
        break;
      case 'webpageGrabber':
        openDialog('webpageGrabber');
        break;
      case 'mediaDownload':
        openDialog('mediaDownload');
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
  const [localSearchInput, setLocalSearchInput] = useState(searchQuery);

  useEffect(() => {
    setLocalSearchInput(searchQuery); // eslint-disable-line react-hooks/set-state-in-effect
  }, [searchQuery]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (localSearchInput !== searchQuery) {
        setSearchQuery(localSearchInput);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [localSearchInput, searchQuery, setSearchQuery]);

  const toggleDropdown = (id: DropdownId) => {
    setOpenDropdown((prev) => (prev === id ? null : id));
  };

  const closeDropdown = () => {
    setOpenDropdown(null);
  };

  // Close dropdowns on Escape key
  React.useEffect(() => {
    if (!openDropdown) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDropdown();
    };
    window.addEventListener('keydown', handleEscape);
    return () => { window.removeEventListener('keydown', handleEscape); };
  }, [openDropdown]);

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
                  openDialog('addDownload');
                }}
                className="px-3 py-1.5 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white font-extrabold transition-all cursor-pointer flex items-center gap-1.5 text-xs border-r border-white/15"
                title={t('topbar_new_download_tip')}
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
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                  >
                    <Plus className="w-4 h-4 text-[var(--success)] shrink-0" />
                    <span>{t('topbar_single_url')}</span>
                  </button>
                  <button
                    onClick={() => {
                      openDialog('batchDownload');
                      closeDropdown();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                  >
                    <Layers className="w-4 h-4 text-[var(--info)] shrink-0" />
                    <span>{t('topbar_batch_download')}</span>
                  </button>
                  <button
                    onClick={() => {
                      openDialog('webpageGrabber');
                      closeDropdown();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                  >
                    <Globe className="w-4 h-4 text-[var(--info)] shrink-0" />
                    <span>{t('dlg_webpage_grabber')}</span>
                  </button>
                  <button
                    onClick={() => {
                      openDialog('mediaDownload');
                      closeDropdown();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                  >
                    <Video className="w-4 h-4 text-[var(--danger)] shrink-0" />
                    <span>{t('dlg_media_downloader')}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="h-5 w-px bg-[var(--border-color)] mx-1 shrink-0" />

        {/* Action: Resume (Split Button) */}
        {toolbarButtonVisible('resume') && (
          <div className="relative">
            <div className="flex items-stretch rounded-lg border border-[var(--border-color)] hover:border-[var(--success-border)] hover:bg-[var(--success-bg)] hover:scale-[1.03] active:scale-[0.97] transition-all duration-150 overflow-hidden shrink-0">
              <button
                onClick={() => {
                  if (canResumeSelected && selectedTaskId) {
                    resumeTask(selectedTaskId);
                  } else {
                    handleResumeAll();
                  }
                }}
                className="px-3 py-1.5 text-[var(--text-secondary)] hover:text-[var(--success)] hover:bg-[var(--success-bg)] transition-all cursor-pointer flex items-center gap-1 text-xs font-bold"
                title={hasSelectedTask ? t('topbar_resume_selected_tip') : t('topbar_resume_all_tip')}
              >
                {renderButtonContent(
                  'resume',
                  <Play className="w-4 h-4 text-[var(--success)] fill-[var(--success-bg)]" />,
                  t('resume'),
                )}
              </button>
              {toolbarShowsDropdown('resume') && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleDropdown('resume');
                  }}
                  className="px-1.5 text-[var(--text-secondary)] hover:text-[var(--success)] hover:bg-[var(--success-bg)] transition-all cursor-pointer flex items-center justify-center border-l border-[var(--border-color)]"
                  aria-label={t('topbar_more_resume_options')}
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
                    <Play className="w-4 h-4 text-[var(--success)] shrink-0" />
                    <span>{t('topbar_resume_selected')}</span>
                  </button>
                  <button
                    onClick={() => {
                      handleResumeAll();
                      closeDropdown();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                  >
                    <Play className="w-4 h-4 text-[var(--success)] shrink-0" />
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
            <div className="flex items-stretch rounded-lg border border-[var(--border-color)] hover:border-[var(--danger-border)] hover:bg-[var(--danger-bg)] hover:scale-[1.03] active:scale-[0.97] transition-all duration-150 overflow-hidden shrink-0">
              <button
                onClick={() => {
                  if (canStopSelected && selectedTaskId) {
                    pauseTask(selectedTaskId);
                  } else {
                    handleStopAll();
                  }
                }}
                className="px-3 py-1.5 text-[var(--text-secondary)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-all cursor-pointer flex items-center gap-1 text-xs font-bold"
                title={hasSelectedTask ? t('topbar_stop_selected_tip') : t('topbar_stop_all_tip')}
              >
                {renderButtonContent(
                  'stop',
                  <Square className="w-3.5 h-3.5 text-[var(--danger)] fill-[var(--danger-bg)]" />,
                  t('topbar_stop'),
                )}
              </button>
              {toolbarShowsDropdown('stop') && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleDropdown('stop');
                  }}
                  className="px-1.5 text-[var(--text-secondary)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-all cursor-pointer flex items-center justify-center border-l border-[var(--border-color)]"
                  aria-label={t('topbar_more_options')}
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
                    <Square className="w-4 h-4 text-[var(--danger)] shrink-0" />
                    <span>{t('topbar_stop_selected')}</span>
                  </button>
                  <button
                    onClick={() => {
                      handleStopAll();
                      closeDropdown();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-md transition-colors flex items-center gap-2.5 cursor-pointer font-bold"
                  >
                    <Square className="w-4 h-4 text-[var(--danger)] shrink-0" />
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
            <div className="flex items-stretch rounded-lg border border-[var(--border-color)] hover:border-[var(--danger-border)] hover:bg-[var(--danger-bg)] hover:scale-[1.03] active:scale-[0.97] transition-all duration-150 overflow-hidden shrink-0">
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
                className="px-3 py-1.5 text-[var(--danger)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-all cursor-pointer flex items-center gap-1 text-xs font-bold"
                title={hasSelectedTask ? t('topbar_delete_selected_tip') : t('topbar_delete_all_tip')}
              >
                {renderButtonContent('delete', <Trash2 className="w-4 h-4" />, t('action_delete'))}
              </button>
              {toolbarShowsDropdown('delete') && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleDropdown('delete');
                  }}
                  className="px-1.5 text-[var(--danger)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-all cursor-pointer flex items-center justify-center border-l border-[var(--border-color)]"
                  aria-label={t('topbar_more_options')}
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
                    <Trash2 className="w-4 h-4 text-[var(--danger)] shrink-0" />
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
                    <Trash2 className="w-4 h-4 text-[var(--danger)] shrink-0" />
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
                    <CheckCircle2 className="w-4 h-4 text-[var(--success)] shrink-0" />
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
            className="px-3 py-1.5 border border-[var(--border-color)] rounded-lg text-[var(--text-secondary)] hover:text-[var(--warning)] hover:border-[var(--warning-border)] hover:bg-[var(--warning-bg)] transition-all cursor-pointer flex items-center gap-1 text-xs font-bold shrink-0 hover:scale-[1.03] active:scale-[0.97] duration-150"
            title={t('topbar_scheduler_tip')}
          >
            {renderButtonContent(
              'scheduler',
              <Clock className="w-4 h-4 text-[var(--warning)]" />,
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
            value={localSearchInput}
            onChange={(e) => {
              setLocalSearchInput(e.target.value);
            }}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg py-1.5 pr-8 pl-3 text-xs focus:outline-none focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)] text-[var(--text-primary)] font-medium"
          />
        </div>
      </div>
    </header>
  );
};
