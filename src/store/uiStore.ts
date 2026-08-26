import { create } from 'zustand';
import type { DownloadItem, DialogState, AppPage, ToastItem, FileType } from '../types/desktop-ui.types';
import { createLocalId } from '../utils/idUtils';
import { playAppSound } from '../utils/sound';
import { settingsStore } from './settingsStore';

type WorkspaceView = 'all' | 'unfinished' | 'finished' | 'queued' | FileType | 'browser' | 'scheduler' | 'diagnostics';

interface UIState {
  selectedTaskId: string | null;
  workspaceView: WorkspaceView;
  searchQuery: string;
  dialog: DialogState;
  activePage: AppPage;
  toasts: ToastItem[];
  isNotificationsMuted: boolean;
  activeProgressMinimizedToTaskbar: boolean;
  minimizedProgressTask: DownloadItem | null;
  completionDialogQueue: DownloadItem[];

  setSelectedTaskId: (id: string | null) => void;
  setWorkspaceView: (view: WorkspaceView) => void;
  setSearchQuery: (query: string) => void;
  setActivePage: (page: AppPage) => void;
  openDialog: (active: string, payload?: unknown) => void;
  closeDialog: () => void;
  addToast: (
    type: 'success' | 'error' | 'info' | 'warning',
    title: string,
    message: string,
    action?: { label: string; onClick: () => void },
  ) => void;
  removeToast: (id: string) => void;
  setIsNotificationsMuted: (muted: boolean) => void;
  setActiveProgressMinimizedToTaskbar: (minimized: boolean) => void;
  setMinimizedProgressTask: (task: DownloadItem | null) => void;
  minimizeActiveProgressToTaskbar: (task?: DownloadItem | null) => void;
  presentDownloadCompletion: (task: DownloadItem) => void;
  dismissActiveProgressForTask: (taskId: string) => void;
  clearCompletionDialogQueue: () => void;
}

export const uiStore = create<UIState>()((set, get) => ({
  selectedTaskId: null,
  workspaceView: 'all',
  searchQuery: '',
  dialog: { active: null },
  activePage: 'downloads',
  toasts: [],
  isNotificationsMuted: localStorage.getItem('nova_notifications_muted') === 'true',
  activeProgressMinimizedToTaskbar: false,
  minimizedProgressTask: null,
  completionDialogQueue: [],

  setSelectedTaskId: (id) => {
    set({ selectedTaskId: id });
  },
  setWorkspaceView: (view) => {
    set({ workspaceView: view });
  },
  setSearchQuery: (query) => {
    set({ searchQuery: query });
  },
  setActivePage: (page) => {
    set({ activePage: page });
  },

  openDialog: (active, payload) => {
    if (active === 'settings' || active === 'scheduler') {
      set({ dialog: { active: null } });
      get().setActivePage(active);
      return;
    }
    if (active === 'mediaDownload' || active === 'webpageGrabber' || active === 'batchDownload') {
      const page = active === 'batchDownload' ? 'batchImport' : active;
      set({ dialog: { active: null, payload } });
      get().setActivePage(page);
      return;
    }
    if (active === 'activeProgress') {
      set({ activeProgressMinimizedToTaskbar: false, minimizedProgressTask: null });
    }
    set({ dialog: { active, payload } });
  },

  closeDialog: () => {
    set((previous) => {
      const hasQueuedCompletion = previous.completionDialogQueue.length > 0;
      const nextCompletion = hasQueuedCompletion ? previous.completionDialogQueue[0] : null;
      const remainingCompletions = hasQueuedCompletion ? previous.completionDialogQueue.slice(1) : [];
      return {
        activeProgressMinimizedToTaskbar: false,
        minimizedProgressTask: null,
        completionDialogQueue: remainingCompletions,
        dialog: nextCompletion ? { active: 'downloadCompleted', payload: nextCompletion } : { active: null },
      };
    });
    const page = get().activePage;
    if (page === 'mediaDownload' || page === 'webpageGrabber' || page === 'batchImport') {
      get().setActivePage('downloads');
    }
  },

  addToast: (type, title, message, action) => {
    if (get().isNotificationsMuted) return;
    const s = settingsStore.getState();
    if (s.settings.sounds.toastSound) {
      playAppSound(s.settings, type === 'error' ? 'error' : 'notification');
    }
    const id = createLocalId('toast');
    set((prev) => {
      const next = [...prev.toasts, { id, type, title, message, action }];
      return { toasts: next.length > 50 ? next.slice(-50) : next };
    });
    setTimeout(
      () => {
        get().removeToast(id);
      },
      action ? 6000 : 4500,
    );
  },

  removeToast: (id) => {
    set((prev) => ({ toasts: prev.toasts.filter((t) => t.id !== id) }));
  },

  setIsNotificationsMuted: (muted) => {
    localStorage.setItem('nova_notifications_muted', String(muted));
    set({ isNotificationsMuted: muted });
  },

  setActiveProgressMinimizedToTaskbar: (minimized) => {
    set({ activeProgressMinimizedToTaskbar: minimized });
  },
  setMinimizedProgressTask: (task) => {
    set({ minimizedProgressTask: task });
  },

  minimizeActiveProgressToTaskbar: (task) => {
    const state = get();
    const fallbackTask =
      task ||
      (state.dialog.active === 'activeProgress'
        ? (state.dialog.payload as DownloadItem | null | undefined) || null
        : null);
    if (!fallbackTask) return;
    set({ minimizedProgressTask: fallbackTask, activeProgressMinimizedToTaskbar: true, dialog: { active: null } });
  },

  presentDownloadCompletion: (task) => {
    set((previous) => {
      const activeProgressTaskId =
        previous.dialog.active === 'activeProgress'
          ? ((previous.dialog.payload as { id?: string } | null | undefined)?.id ?? null)
          : null;
      const alreadyActive =
        previous.dialog.active === 'downloadCompleted' &&
        (previous.dialog.payload as { id?: string } | null | undefined)?.id === task.id;
      const alreadyQueued = previous.completionDialogQueue.some((queued) => queued.id === task.id);
      if (alreadyActive || alreadyQueued) return previous;

      // Replacing the progress view of the same task avoids leaving the obsolete
      // Finished action on screen. Other active dialogs are respected and receive
      // this completion when they close.
      if (previous.dialog.active === null || activeProgressTaskId === task.id) {
        return {
          ...previous,
          activeProgressMinimizedToTaskbar: false,
          minimizedProgressTask: null,
          dialog: { active: 'downloadCompleted', payload: task },
        };
      }

      return { ...previous, completionDialogQueue: [...previous.completionDialogQueue, task] };
    });
  },

  dismissActiveProgressForTask: (taskId) => {
    set((previous) => {
      if (previous.dialog.active !== 'activeProgress') return previous;
      const activeTaskId = (previous.dialog.payload as { id?: string } | null | undefined)?.id;
      if (activeTaskId !== taskId) return previous;
      return {
        ...previous,
        activeProgressMinimizedToTaskbar: false,
        minimizedProgressTask: null,
        dialog: { active: null },
      };
    });
  },

  clearCompletionDialogQueue: () => {
    set({ completionDialogQueue: [] });
  },
}));
