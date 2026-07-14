import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useCallback } from 'react';
import { taskStore } from './taskStore';
import { queueStore } from './queueStore';
import { settingsStore } from './settingsStore';
import { bridgeStore } from './bridgeStore';
import { uiStore } from './uiStore';
import { getTranslation } from '../lib/i18n/translations';

export function useTaskData() {
  return useStore(taskStore, (s) => s.tasks);
}

export function useTaskSelectors() {
  const tasks = useStore(taskStore, (s) => s.tasks);
  const selectedTaskId = useStore(uiStore, (s) => s.selectedTaskId);
  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;
  const activeCount = tasks.filter((t) => t.status === 'downloading').length;
  const queuedCount = tasks.filter((t) => t.status === 'queued').length;
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const pausedCount = tasks.filter((t) => t.status === 'paused').length;
  const errorCount = tasks.filter((t) => t.status === 'error').length;
  return { tasks, selectedTaskId, selectedTask, activeCount, queuedCount, completedCount, pausedCount, errorCount };
}

export function useTaskActions() {
  return {
    setSelectedTaskId: uiStore.getState().setSelectedTaskId,
    addTask: taskStore.getState().addTask,
    pauseTask: taskStore.getState().pauseTask,
    resumeTask: taskStore.getState().resumeTask,
    deleteTask: taskStore.getState().deleteTask,
    openTaskFile: taskStore.getState().openTaskFile,
    openTaskLocation: taskStore.getState().openTaskLocation,
    updateTaskProperties: taskStore.getState().updateTaskProperties,
    triggerBatchDownload: taskStore.getState().triggerBatchDownload,
  };
}

export function useQueueData() {
  return useStore(queueStore, (s) => s.queues);
}

export function useQueueActions() {
  return {
    updateQueue: queueStore.getState().updateQueue,
    addQueue: queueStore.getState().addQueue,
    deleteQueue: queueStore.getState().deleteQueue,
    removeTaskFromQueue: queueStore.getState().removeTaskFromQueue,
    moveTaskToQueue: queueStore.getState().moveTaskToQueue,
    createQueueAndMoveTask: queueStore.getState().createQueueAndMoveTask,
    reorderQueues: queueStore.getState().reorderQueues,
    snapshotForUndo: queueStore.getState().snapshotForUndo,
    undoLast: queueStore.getState().undoLast,
  };
}

export function useSettingsData() {
  return useStore(settingsStore, (s) => s.settings);
}

export function useSettingsActions() {
  return {
    updateSettings: settingsStore.getState().updateSettings,
    updateThemeSettings: settingsStore.getState().updateThemeSettings,
  };
}

export function useThemeData() {
  return useStore(settingsStore, (s) => s.themeSettings);
}

export function useBridgeData() {
  return useStore(bridgeStore, useShallow((s) => ({
    status: s.status,
    version: s.version,
    pid: s.pid,
    speedLimit: s.speedLimit,
  })));
}

export function useIsDegraded() {
  return useStore(bridgeStore, (s) => s.isDegradedMode);
}

export function useDialogData() {
  return useStore(uiStore, useShallow((s) => ({ active: s.dialog.active, payload: s.dialog.payload })));
}

export function useDialogActions() {
  return {
    openDialog: uiStore.getState().openDialog,
    closeDialog: uiStore.getState().closeDialog,
  };
}

export function useToastData() {
  return useStore(uiStore, (s) => s.toasts);
}

export function useToastActions() {
  return {
    addToast: uiStore.getState().addToast,
    removeToast: uiStore.getState().removeToast,
  };
}

export function useNavigationData() {
  const activePage = useStore(uiStore, (s) => s.activePage);
  const workspaceView = useStore(uiStore, (s) => s.workspaceView);
  return { activePage, workspaceView };
}

export function useNavigationActions() {
  return {
    setActivePage: uiStore.getState().setActivePage,
    setWorkspaceView: uiStore.getState().setWorkspaceView,
  };
}

export function useSearchQuery() {
  const searchQuery = useStore(uiStore, (s) => s.searchQuery);
  const setSearchQuery = uiStore.getState().setSearchQuery;
  return { searchQuery, setSearchQuery };
}

export function useNotificationsData() {
  const isNotificationsMuted = useStore(uiStore, (s) => s.isNotificationsMuted);
  const setIsNotificationsMuted = uiStore.getState().setIsNotificationsMuted;
  return { isNotificationsMuted, setIsNotificationsMuted };
}

export function useMinimizedProgress() {
  const activeProgressMinimizedToTaskbar = useStore(uiStore, (s) => s.activeProgressMinimizedToTaskbar);
  const minimizedProgressTask = useStore(uiStore, (s) => s.minimizedProgressTask);
  const minimizeActiveProgressToTaskbar = uiStore.getState().minimizeActiveProgressToTaskbar;
  const setActiveProgressMinimizedToTaskbar = uiStore.getState().setActiveProgressMinimizedToTaskbar;
  const setMinimizedProgressTask = uiStore.getState().setMinimizedProgressTask;
  return { activeProgressMinimizedToTaskbar, minimizedProgressTask, minimizeActiveProgressToTaskbar, setActiveProgressMinimizedToTaskbar, setMinimizedProgressTask };
}

export function useI18n() {
  const i18nRevision = useStore(settingsStore, (s) => s.i18nRevision);
  const language = useStore(settingsStore, (s) => s.settings.extra.language);
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => {
      void i18nRevision;
      return getTranslation(language || 'en', key, params);
    },
    [language, i18nRevision],
  );
  return t;
}
