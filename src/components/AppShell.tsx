/* src/components/AppShell.tsx */
import React, { useEffect, useState, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../state/appStore';
import { TopBar } from './TopBar';
import { TaskTable } from './TaskTable';
import { StatusBar } from './StatusBar';
import { SettingsPage } from '../pages/SettingsPage';
import { SchedulerPage } from '../pages/SchedulerPage';
import DialogRoot from '../dialogs/DialogRoot';
import { AlertCircle, CheckCircle, Info, X, RefreshCw, Minus, Square } from 'lucide-react';
import { Logo } from './Logo';
import { extractFirstHttpUrl, readClipboardText } from '../utils/clipboard';
import { getDialogForUrl } from '../utils/urlDetector';
import { ErrorBoundary } from './ErrorBoundary';

const isEditableTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return !!element.closest('input, textarea, select, [contenteditable="true"]');
};

const normalizeShortcut = (shortcut: string) =>
  shortcut
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join('+');

const shortcutFromEvent = (event: KeyboardEvent) => {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.metaKey) parts.push('meta');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
  if (!['control', 'shift', 'alt', 'meta'].includes(key)) {
    parts.push(key);
  }
  return normalizeShortcut(parts.join('+'));
};

export const AppShell: React.FC = () => {
  return (
    <ErrorBoundary>
      <AppShellInner />
    </ErrorBoundary>
  );
};

const AppShellInner: React.FC = () => {
  const {
    toasts,
    removeToast,
    openDialog,
    addToast,
    bridge,
    settings,
    updateSettings,
    dialog,
    activePage,
    setActivePage,
    tasks,
    selectedTaskId,
    pauseTask,
    resumeTask,
    deleteTask,
    isNotificationsMuted,
    setIsNotificationsMuted,
    t,
  } = useAppStore();

  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [connectTimer, setConnectTimer] = useState(0);
  const dragCounter = useRef(0);
  const lastClipboardText = useRef('');
  const clipboardPrimed = useRef(false);
  const lastClipboardOpenedAt = useRef(0);

  // Reset the elapsed counter when leaving the connecting state, adjusting
  // during render; the effect only drives the ticking interval.
  const [prevBridgeStatus, setPrevBridgeStatus] = useState(bridge.status);
  if (prevBridgeStatus !== bridge.status) {
    setPrevBridgeStatus(bridge.status);
    if (bridge.status !== 'connecting') {
      setConnectTimer(0);
    }
  }

  useEffect(() => {
    if (bridge.status !== 'connecting') {
      return;
    }
    const interval = window.setInterval(() => {
      setConnectTimer((t) => t + 1);
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, [bridge.status]);

  useEffect(() => {
    const preventUnsupportedContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-native-context-menu="true"]')) {
        return;
      }
      event.preventDefault();
    };

    window.addEventListener('contextmenu', preventUnsupportedContextMenu);
    return () => {
      window.removeEventListener('contextmenu', preventUnsupportedContextMenu);
    };
  }, []);

  // Escape navigates back from a full page when no dialog is open on top of it.
  useEffect(() => {
    if (activePage === 'downloads') return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || dialog.active) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        return;
      }
      setActivePage('downloads');
    };
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [activePage, dialog.active, setActivePage]);

  useEffect(() => {
    if (!settings.general.monitorClipboard || (bridge.status !== 'connected' && bridge.status !== 'degraded')) {
      clipboardPrimed.current = false;
      lastClipboardText.current = '';
      return;
    }

    let cancelled = false;
    const pollClipboard = async () => {
      try {
        const text = (await readClipboardText()).trim();
        if (cancelled) return;

        if (!clipboardPrimed.current) {
          lastClipboardText.current = text;
          clipboardPrimed.current = true;
          return;
        }

        if (!text || text === lastClipboardText.current) return;
        lastClipboardText.current = text;

        const copiedUrl = extractFirstHttpUrl(text);
        if (!copiedUrl || dialog.active) return;

        const now = Date.now();
        if (now - lastClipboardOpenedAt.current < 1500) return;
        lastClipboardOpenedAt.current = now;
        openDialog(getDialogForUrl(copiedUrl), copiedUrl);
      } catch {
        // Clipboard access can be temporarily unavailable while another app owns it.
      }
    };

    void pollClipboard();
    const interval = window.setInterval(() => {
      void pollClipboard();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [settings.general.monitorClipboard, bridge.status, dialog.active, openDialog]);

  useEffect(() => {
    if (!settings.keyboardShortcuts.enabled) return;

    const bindings = Object.entries(settings.keyboardShortcuts.bindings)
      .map(([action, shortcut]) => [action, normalizeShortcut(shortcut)] as const)
      .filter(([, shortcut]) => shortcut.length > 0);

    const stopAll = () => {
      const active = tasks.filter((task) => task.status === 'downloading');
      if (active.length === 0) {
        addToast('info', t('topbar_stop_all_title'), t('topbar_stop_all_none'));
        return;
      }
      active.forEach((task) => {
        pauseTask(task.id);
      });
      addToast('warning', t('topbar_stop_all_title'), t('topbar_stop_all_done', { count: active.length }));
    };

    const resumeAll = () => {
      const inactive = tasks.filter((task) => task.status === 'paused' || task.status === 'queued');
      if (inactive.length === 0) {
        addToast('info', t('topbar_resume_all_title'), t('topbar_resume_all_none'));
        return;
      }
      inactive.forEach((task) => {
        resumeTask(task.id);
      });
      addToast('success', t('topbar_resume_all_title'), t('topbar_resume_all_done', { count: inactive.length }));
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcut = shortcutFromEvent(event);
      const match = bindings.find(([, value]) => value === shortcut);
      if (!match) return;

      const [action] = match;
      if (isEditableTarget(event.target) && action !== 'focusSearch') return;
      event.preventDefault();

      const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : null;
      switch (action) {
        case 'addDownload':
          openDialog('addDownload');
          break;
        case 'batchDownload':
          openDialog('batchDownload');
          break;
        case 'focusSearch': {
          const input = document.querySelector<HTMLInputElement>('[data-global-search="true"]');
          input?.focus();
          input?.select();
          break;
        }
        case 'resumeSelected':
          if (selectedTask && (selectedTask.status === 'paused' || selectedTask.status === 'queued' || selectedTask.status === 'error')) {
            resumeTask(selectedTask.id);
          }
          break;
        case 'resumeAll':
          resumeAll();
          break;
        case 'stopSelected':
          if (selectedTask?.status === 'downloading') {
            pauseTask(selectedTask.id);
          }
          break;
        case 'stopAll':
          stopAll();
          break;
        case 'deleteSelected':
          if (selectedTask) {
            openDialog('confirmDelete', selectedTask);
          }
          break;
        case 'deleteCompleted':
          openDialog('genericConfirm', {
            message: t('topbar_delete_completed_confirm'),
            isDanger: true,
            onConfirm: () => {
              tasks
                .filter((task) => task.status === 'completed')
                .forEach((task) => {
                  void deleteTask(task.id, false);
                });
            },
          });
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
        case 'toggleSpeedLimiter': {
          const updated = structuredClone(settings);
          updated.connection.speedLimiter.enabled = !updated.connection.speedLimiter.enabled;
          updateSettings(updated);
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    addToast,
    deleteTask,
    isNotificationsMuted,
    openDialog,
    pauseTask,
    resumeTask,
    selectedTaskId,
    setIsNotificationsMuted,
    settings,
    t,
    tasks,
    updateSettings,
  ]);

  // Internal drags (column reorder, queue reorder) must not trigger the URL drop overlay.
  const isInternalDrag = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    return (
      types.includes('application/x-nova-column') ||
      types.includes('application/x-nova-customize-column') ||
      types.includes('application/x-nova-queue-task')
    );
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isInternalDrag(e)) {
      return;
    }

    dragCounter.current++;
    if (e.dataTransfer.items.length > 0) {
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isInternalDrag(e)) {
      return;
    }

    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDraggingOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isInternalDrag(e)) {
      return;
    }

    setIsDraggingOver(false);
    dragCounter.current = 0;

    const droppedText = e.dataTransfer.getData('text/plain');

    // Local files cannot be converted into a real remote URL.
    if (!droppedText && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      addToast('warning', t('shell_local_file_title'), t('shell_local_file_desc', { name: file.name }));
      return;
    }

    if (droppedText) {
      openDialog('addDownload', droppedText.trim());
    }
  };

  const getToastIcon = (type: string) => {
    switch (type) {
      case 'success':
        return <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />;
      case 'warning':
        return <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />;
      default:
        return <Info className="w-4 h-4 text-blue-500 shrink-0" />;
    }
  };

  if (bridge.status === 'connecting') {
    return (
      <div className="flex flex-col items-center justify-center h-screen w-screen bg-[var(--bg-app)] text-[var(--text-primary)] gap-6">
        <Logo size={64} className="animate-pulse opacity-80" />
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-lg font-bold">{t('app_name')}</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            {connectTimer > 25
              ? t('shell_connect_failed')
              : connectTimer > 15
                ? t('shell_connect_still_trying')
                : t('shell_connecting')}
          </p>
          {connectTimer > 25 && (
            <button
              onClick={() => {
                setConnectTimer(0);
                window.location.reload();
              }}
              className="mt-2 px-4 py-1.5 text-[11px] font-bold bg-[var(--accent-primary)] text-white rounded transition-all duration-150 hover:scale-[1.03] active:scale-[0.97] cursor-pointer"
            >
              {t('shell_retry')}
            </button>
          )}
        </div>
        {connectTimer <= 25 && <RefreshCw className="w-5 h-5 animate-spin text-[var(--accent-primary)]" />}
      </div>
    );
  }

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)] relative"
      dir="ltr"
    >
      {/* Visual Drag and Drop Overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-slate-950/85 backdrop-blur-md border-4 border-dashed border-[var(--accent-primary)] animate-in fade-in duration-200">
          <div className="p-8 rounded-full bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] mb-4 animate-bounce">
            <Logo size={64} />
          </div>
          <h3 className="text-xl font-bold text-white mb-2">{t('shell_drop_title')}</h3>
          <p className="text-xs text-slate-300">{t('shell_drop_desc')}</p>
        </div>
      )}

      {/* Custom Title Bar */}
      <div
        data-tauri-drag-region
        className="bg-[var(--bg-sidebar)] h-8 px-2 flex items-center justify-between text-[11px] font-semibold text-[var(--text-secondary)] select-none shrink-0"
        style={{ direction: 'ltr' }}
      >
        <div data-tauri-drag-region className="flex items-center gap-2">
          <Logo size={16} />
          <span className="text-[11px] font-bold text-[var(--text-primary)]">{t('app_name')}</span>
        </div>
        <div className="flex items-center h-full">
          <button
            onClick={() => {
              if (isTauri()) {
                void getCurrentWindow().minimize();
              }
            }}
            className="h-full px-3 hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center cursor-pointer"
            title={t('win_minimize')}
          >
            <Minus className="w-3 h-3 text-[var(--text-secondary)]" />
          </button>
          <button
            onClick={() => {
              if (isTauri()) {
                void getCurrentWindow().toggleMaximize();
              }
            }}
            className="h-full px-3 hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center cursor-pointer"
            title={t('win_maximize')}
          >
            <Square className="w-3 h-3 text-[var(--text-secondary)]" />
          </button>
          <button
            onClick={() => {
              if (isTauri()) {
                void getCurrentWindow().close();
              }
            }}
            className="h-full px-3 hover:bg-red-500 hover:text-white transition-colors flex items-center justify-center cursor-pointer"
            title={t('btn_close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {/* 2. Main Workspace Layout — downloads view or a full page (settings / lists) */}
        <div className="flex-1 flex flex-col h-full overflow-hidden">
          {activePage === 'settings' ? (
            <SettingsPage />
          ) : activePage === 'scheduler' ? (
            <SchedulerPage />
          ) : (
            <>
              {/* Top bar toolbar */}
              <TopBar />

              {/* Content Container (Grid) */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
                <TaskTable />
              </div>
            </>
          )}

          {/* Bottom Status Bar */}
          <StatusBar />
        </div>
      </div>

      {/* 3. Centralized Dialog router */}
      <DialogRoot />

      {/* 4. Responsive Toast Notification HUD */}
      <div
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm select-none"
        style={{ direction: 'ltr' }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="glass-panel bg-[var(--bg-surface-elevated)] border border-[var(--border-color)] p-3 rounded-lg shadow-xl flex items-start gap-3 animate-in slide-in-from-right duration-200"
          >
            {getToastIcon(toast.type)}
            <div className="flex-1 space-y-0.5 text-left">
              <h5 className="text-xs font-bold text-[var(--text-primary)]">{toast.title}</h5>
              <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">{toast.message}</p>
            </div>
            <button
              onClick={() => {
                removeToast(toast.id);
              }}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-0.5 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
