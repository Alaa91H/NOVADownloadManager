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

  setSelectedTaskId: (id) => { set({ selectedTaskId: id }); },
  setWorkspaceView: (view) => { set({ workspaceView: view }); },
  setSearchQuery: (query) => { set({ searchQuery: query }); },
  setActivePage: (page) => { set({ activePage: page }); },

  openDialog: (active, payload) => {
    if (active === 'settings' || active === 'scheduler') {
      set({ dialog: { active: null } });
      get().setActivePage(active);
      return;
    }
    if (active === 'mediaDownload') {
      set({ dialog: { active: null, payload } });
      get().setActivePage('mediaDownload');
      return;
    }
    if (active === 'activeProgress') {
      set({ activeProgressMinimizedToTaskbar: false, minimizedProgressTask: null });
    }
    set({ dialog: { active, payload } });
  },

  closeDialog: () => {
    set({ activeProgressMinimizedToTaskbar: false, minimizedProgressTask: null, dialog: { active: null } });
    if (get().activePage === 'mediaDownload') {
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
    setTimeout(() => {
      get().removeToast(id);
    }, action ? 6000 : 4500);
  },

  removeToast: (id) => { set((prev) => ({ toasts: prev.toasts.filter((t) => t.id !== id) })); },

  setIsNotificationsMuted: (muted) => {
    localStorage.setItem('nova_notifications_muted', String(muted));
    set({ isNotificationsMuted: muted });
  },

  setActiveProgressMinimizedToTaskbar: (minimized) => { set({ activeProgressMinimizedToTaskbar: minimized }); },
  setMinimizedProgressTask: (task) => { set({ minimizedProgressTask: task }); },

  minimizeActiveProgressToTaskbar: (task) => {
    const state = get();
    const fallbackTask =
      task ||
      (state.dialog.active === 'activeProgress' ? (state.dialog.payload as DownloadItem | null | undefined) || null : null);
    if (!fallbackTask) return;
    set({ minimizedProgressTask: fallbackTask, activeProgressMinimizedToTaskbar: true, dialog: { active: null } });
  },
}));
