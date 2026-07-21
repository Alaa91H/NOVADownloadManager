import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useCallback, useMemo } from 'react';
import { taskStore } from './taskStore';
import { queueStore } from './queueStore';
import { settingsStore } from './settingsStore';
import { bridgeStore } from './bridgeStore';
import { uiStore } from './uiStore';
import { getTranslation } from '../lib/i18n/translations';

export function useTaskData() {
  // useShallow ensures components only re-render when the array contents
  // actually change (by reference), not on every poll cycle. This works
  // because mergeDaemonTasks preserves object identity for unchanged tasks.
  return useStore(
    taskStore,
    useShallow((s) => s.tasks),
  );
}

export function useTaskSelectors() {
  const selectedTaskId = useStore(uiStore, (s) => s.selectedTaskId);
  return { selectedTaskId };
}

export function useTaskActions() {
  return useMemo(
    () => ({
      setSelectedTaskId: uiStore.getState().setSelectedTaskId,
      addTask: taskStore.getState().addTask,
      pauseTask: taskStore.getState().pauseTask,
      resumeTask: taskStore.getState().resumeTask,
      deleteTask: taskStore.getState().deleteTask,
      openTaskFile: taskStore.getState().openTaskFile,
      openTaskLocation: taskStore.getState().openTaskLocation,
      updateTaskProperties: taskStore.getState().updateTaskProperties,
      triggerBatchDownload: taskStore.getState().triggerBatchDownload,
    }),
    [],
  );
}

export function useQueueData() {
  return useStore(queueStore, (s) => s.queues);
}

export function useQueueActions() {
  return useMemo(
    () => ({
      updateQueue: queueStore.getState().updateQueue,
      addQueue: queueStore.getState().addQueue,
      deleteQueue: queueStore.getState().deleteQueue,
      removeTaskFromQueue: queueStore.getState().removeTaskFromQueue,
      moveTaskToQueue: queueStore.getState().moveTaskToQueue,
      createQueueAndMoveTask: queueStore.getState().createQueueAndMoveTask,
      reorderQueues: queueStore.getState().reorderQueues,
      snapshotForUndo: queueStore.getState().snapshotForUndo,
      undoLast: queueStore.getState().undoLast,
    }),
    [],
  );
}

export function useSettingsData() {
  return useStore(settingsStore, (s) => s.settings);
}

export function useSettingsActions() {
  return useMemo(
    () => ({
      updateSettings: settingsStore.getState().updateSettings,
      updateThemeSettings: settingsStore.getState().updateThemeSettings,
    }),
    [],
  );
}

export function useThemeData() {
  return useStore(settingsStore, (s) => s.themeSettings);
}

export function useBridgeData() {
  return useStore(
    bridgeStore,
    useShallow((s) => ({
      status: s.status,
      version: s.version,
      pid: s.pid,
      speedLimit: s.speedLimit,
    })),
  );
}

export function useIsDegraded() {
  return useStore(bridgeStore, (s) => s.isDegradedMode);
}

export function useDialogData() {
  return useStore(
    uiStore,
    useShallow((s) => ({ active: s.dialog.active, payload: s.dialog.payload })),
  );
}

export function useDialogActions() {
  return useMemo(
    () => ({
      openDialog: uiStore.getState().openDialog,
      closeDialog: uiStore.getState().closeDialog,
    }),
    [],
  );
}

export function useToastData() {
  return useStore(uiStore, (s) => s.toasts);
}

export function useToastActions() {
  return useMemo(
    () => ({
      addToast: uiStore.getState().addToast,
      removeToast: uiStore.getState().removeToast,
    }),
    [],
  );
}

export function useNavigationData() {
  const activePage = useStore(uiStore, (s) => s.activePage);
  const workspaceView = useStore(uiStore, (s) => s.workspaceView);
  return { activePage, workspaceView };
}

export function useNavigationActions() {
  return useMemo(
    () => ({
      setActivePage: uiStore.getState().setActivePage,
      setWorkspaceView: uiStore.getState().setWorkspaceView,
    }),
    [],
  );
}

export function useSearchQuery() {
  const searchQuery = useStore(uiStore, (s) => s.searchQuery);
  const setSearchQuery = useMemo(() => uiStore.getState().setSearchQuery, []);
  return useMemo(() => ({ searchQuery, setSearchQuery }), [searchQuery, setSearchQuery]);
}

export function useNotificationsData() {
  const isNotificationsMuted = useStore(uiStore, (s) => s.isNotificationsMuted);
  const setIsNotificationsMuted = useMemo(() => uiStore.getState().setIsNotificationsMuted, []);
  return useMemo(
    () => ({ isNotificationsMuted, setIsNotificationsMuted }),
    [isNotificationsMuted, setIsNotificationsMuted],
  );
}

export function useMinimizedProgress() {
  const activeProgressMinimizedToTaskbar = useStore(uiStore, (s) => s.activeProgressMinimizedToTaskbar);
  const minimizedProgressTask = useStore(uiStore, (s) => s.minimizedProgressTask);
  const actions = useMemo(
    () => ({
      minimizeActiveProgressToTaskbar: uiStore.getState().minimizeActiveProgressToTaskbar,
      setActiveProgressMinimizedToTaskbar: uiStore.getState().setActiveProgressMinimizedToTaskbar,
      setMinimizedProgressTask: uiStore.getState().setMinimizedProgressTask,
    }),
    [],
  );
  return { activeProgressMinimizedToTaskbar, minimizedProgressTask, ...actions };
}

export function useSidebarCounts() {
  return useStore(
    taskStore,
    useShallow((s) => {
      const counts: Record<string, number> = { all: s.tasks.length };
      for (const t of s.tasks) {
        if (t.status !== 'completed') counts['unfinished'] = (counts['unfinished'] || 0) + 1;
        if (t.status === 'completed') counts['finished'] = (counts['finished'] || 0) + 1;
        if (t.status === 'queued') counts['queued'] = (counts['queued'] || 0) + 1;
        counts[t.fileType] = (counts[t.fileType] || 0) + 1;
      }
      return counts;
    }),
  );
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

// ── Engine integration selectors ─────────────────────────────────────────
// These give UI components typed, subscription-based access to the engine
// control surface (bandwidth, rate limit, queue, profiles, retry policy,
// mirrors, plugins, stats, and per-task telemetry) backed by engineStore.

import { useEngineStore } from './engineStore';

export function useEngineBandwidth() {
  return useStore(useEngineStore, (s) => s.bandwidth);
}

export function useEngineRateLimit() {
  return useStore(useEngineStore, (s) => s.rateLimit);
}

export function useEngineQueue() {
  return useStore(useEngineStore, (s) => s.queue);
}

export function useEngineProfiles() {
  return useStore(useEngineStore, (s) => s.profiles);
}

export function useEngineRetryPolicy() {
  return useStore(useEngineStore, (s) => s.retryPolicy);
}

export function useEngineMirrors() {
  return useStore(useEngineStore, (s) => s.mirrors);
}

export function useEnginePlugins() {
  return useStore(useEngineStore, (s) => s.plugins);
}

export function useEngineCache() {
  return useStore(useEngineStore, (s) => s.cache);
}

export function useEngineStats() {
  return useStore(useEngineStore, (s) => s.stats);
}

export function useEngineAdaptive(taskId: string | null) {
  return useStore(useEngineStore, (s) => (taskId ? s.adaptive[taskId] : undefined));
}

export function useEngineSegments(taskId: string | null) {
  return useStore(useEngineStore, (s) => (taskId ? s.segments[taskId] : undefined));
}

export function useEngineActions() {
  return useMemo(
    () => ({
      refreshAll: useEngineStore.getState().refreshAll,
      setBandwidth: useEngineStore.getState().setBandwidth,
      setRateLimit: useEngineStore.getState().setRateLimit,
      setQueuePriority: useEngineStore.getState().setQueuePriority,
      setActiveProfile: useEngineStore.getState().setActiveProfile,
      setRetryPolicy: useEngineStore.getState().setRetryPolicy,
      addMirror: useEngineStore.getState().addMirror,
      triggerFailover: useEngineStore.getState().triggerFailover,
      setFailover: useEngineStore.getState().setFailover,
      clearCache: useEngineStore.getState().clearCache,
      refreshAdaptive: useEngineStore.getState().refreshAdaptive,
      refreshSegments: useEngineStore.getState().refreshSegments,
    }),
    [],
  );
}
