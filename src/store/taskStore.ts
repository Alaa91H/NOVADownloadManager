import { create } from 'zustand';
import type { DownloadItem } from '../types/desktop-ui.types';
import { novaClient } from '../api/novaClient';
import { tauriClient } from '../api/tauriClient';
import { bridgeStore } from './bridgeStore';
import { uiStore } from './uiStore';
import { queueStore } from './queueStore';
import { settingsStore } from './settingsStore';

const isNativeEngineTask = (task: DownloadItem) =>
  task.engine === 'curl' || task.engine === 'libcurl-multi' || task.engine === 'yt-dlp';

/**
 * Merge daemon tasks into the local store, preserving object identity for
 * tasks that haven't changed since the last sync. This is critical for
 * rendering performance: components subscribed via useShallow(useTaskData)
 * only re-render when actual task data changes, not on every 2-second poll.
 */
export const mergeDaemonTasks = (daemonTasks: DownloadItem[]): DownloadItem[] => {
  const prev = taskStore.getState().tasks;
  const prevMap = new Map<string, DownloadItem>();
  for (const t of prev) prevMap.set(t.id, t);

  return daemonTasks.map((task) => {
    const existing = prevMap.get(task.id);
    if (existing && shallowEqualTask(existing, task)) {
      return existing;
    }
    return { ...task };
  });
};

/** Compare two tasks for shallow equality (the fields that change during
 *  download progress). If all relevant fields match, we reuse the old
 *  reference to prevent unnecessary React re-renders. */
function shallowEqualTask(a: DownloadItem, b: DownloadItem): boolean {
  return (
    a.status === b.status &&
    a.downloadedBytes === b.downloadedBytes &&
    a.speedBytesPerSec === b.speedBytesPerSec &&
    a.sizeBytes === b.sizeBytes &&
    a.timeLeftSeconds === b.timeLeftSeconds &&
    a.elapsedSeconds === b.elapsedSeconds &&
    a.engineStatus === b.engineStatus &&
    a.errorMessage === b.errorMessage &&
    a.name === b.name &&
    a.savePath === b.savePath &&
    a.connections === b.connections
  );
}

interface TaskState {
  tasks: DownloadItem[];
  completedTaskIds: Set<string>;
  hasSyncedDownloads: boolean;
  setTasks: (tasks: DownloadItem[]) => void;
  setTasksWith: (updater: (prev: DownloadItem[]) => DownloadItem[]) => void;
  addTask: (
    task: Omit<
      DownloadItem,
      'id' | 'dateAdded' | 'downloadedBytes' | 'speedBytesPerSec' | 'timeLeftSeconds' | 'segments'
    >,
    downloadImmediately: boolean,
  ) => Promise<DownloadItem | null>;
  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  deleteTask: (id: string, deleteDisk: boolean) => Promise<void>;
  openTaskFile: (id: string) => Promise<void>;
  openTaskLocation: (id: string) => Promise<void>;
  renameTask: (id: string, name: string) => Promise<boolean>;
  redownloadTask: (id: string) => Promise<void>;
  refreshTaskLink: (id: string, url: string) => Promise<boolean>;
  updateTaskProperties: (id: string, updatedFields: Partial<DownloadItem>) => void;
  triggerBatchDownload: (
    urls: string[],
    options?: {
      queueId?: string;
      connections?: number;
      saveDirectory?: string;
      description?: string;
      directOptions?: DownloadItem['directOptions'];
    },
  ) => Promise<void>;
  setCompletedTaskIds: (ids: Set<string>) => void;
  setHasSyncedDownloads: (v: boolean) => void;
}

export const taskStore = create<TaskState>()((set, get) => ({
  tasks: [],
  completedTaskIds: new Set<string>(),
  hasSyncedDownloads: false,

  setTasks: (tasks) => {
    set({ tasks });
  },
  setTasksWith: (updater) => {
    set((p) => ({ tasks: updater(p.tasks) }));
  },
  setCompletedTaskIds: (ids) => {
    set({ completedTaskIds: ids });
  },
  setHasSyncedDownloads: (v) => {
    set({ hasSyncedDownloads: v });
  },

  addTask: async (newItem, downloadImmediately) => {
    const { status: bridgeStatus } = bridgeStore.getState();
    if (bridgeStatus === 'connecting' || bridgeStatus === 'disconnected') {
      uiStore
        .getState()
        .addToast('error', 'NOVA daemon unavailable', 'Start the local NOVA daemon before creating downloads.');
      return null;
    }
    try {
      const normalizedTask = {
        ...(await novaClient.createDownload({ ...newItem, startImmediately: downloadImmediately })),
      };
      set((p) => ({ tasks: [normalizedTask, ...p.tasks.filter((item) => item.id !== normalizedTask.id)] }));
      uiStore.getState().setSelectedTaskId(normalizedTask.id);
      bridgeStore.getState().setIsDegradedMode(false);
      if (newItem.queueId) queueStore.getState().addTaskToQueueOrder(normalizedTask.id, newItem.queueId);
      uiStore
        .getState()
        .addToast('success', 'Download added', `"${normalizedTask.name}" was added to the download queue.`);
      if (downloadImmediately) uiStore.getState().openDialog('activeProgress', normalizedTask);
      return normalizedTask;
    } catch (error) {
      bridgeStore.getState().setIsDegradedMode(true);
      uiStore
        .getState()
        .addToast(
          'error',
          'NOVA daemon',
          error instanceof Error ? error.message : 'The local download engine rejected the task.',
        );
      return null;
    }
  },

  pauseTask: async (id) => {
    const targetItem = get().tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      uiStore.getState().addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return;
    }
    try {
      const normalizedTask = { ...(await novaClient.pauseDownload(id)) };
      set((p) => ({ tasks: p.tasks.map((item) => (item.id === id ? normalizedTask : item)) }));
      uiStore.getState().addToast('info', 'Download stopped', `"${normalizedTask.name}" was stopped.`);
    } catch (error) {
      uiStore
        .getState()
        .addToast(
          'error',
          'NOVA daemon',
          error instanceof Error ? error.message : 'The local engine could not stop the download.',
        );
    }
  },

  resumeTask: async (id) => {
    const targetItem = get().tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      uiStore.getState().addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return;
    }
    try {
      const normalizedTask = { ...(await novaClient.resumeDownload(id)) };
      set((p) => ({ tasks: p.tasks.map((item) => (item.id === id ? normalizedTask : item)) }));
      if (normalizedTask.id !== id) {
        uiStore.getState().setSelectedTaskId(normalizedTask.id);
        if (normalizedTask.queueId)
          queueStore.getState().addTaskToQueueOrder(normalizedTask.id, normalizedTask.queueId);
      }
      if (normalizedTask.status === 'downloading') uiStore.getState().openDialog('activeProgress', normalizedTask);
      uiStore.getState().addToast('info', 'Download resumed', `"${normalizedTask.name}" was resumed.`);
    } catch (error) {
      uiStore
        .getState()
        .addToast(
          'error',
          'NOVA daemon',
          error instanceof Error ? error.message : 'The local engine could not resume the download.',
        );
    }
  },

  deleteTask: async (id, deleteDisk) => {
    const targetItem = get().tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      uiStore.getState().addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return;
    }
    try {
      await novaClient.deleteDownload(id, deleteDisk);
      let diskMessage = '';
      if (deleteDisk) {
        diskMessage = targetItem.savePath
          ? ' The daemon also deleted the local file and libcurl partial segments when present.'
          : ' No saved file path was available for disk deletion.';
      }
      set((p) => ({ tasks: p.tasks.filter((t) => t.id !== id) }));
      if (uiStore.getState().selectedTaskId === id) uiStore.getState().setSelectedTaskId(null);
      uiStore
        .getState()
        .addToast('warning', 'Download removed', `"${targetItem.name}" was removed from the daemon.${diskMessage}`);
    } catch (error) {
      uiStore
        .getState()
        .addToast(
          'error',
          'NOVA daemon',
          error instanceof Error ? error.message : 'The local engine could not delete the download.',
        );
    }
  },

  openTaskFile: async (id) => {
    const task = get().tasks.find((item) => item.id === id);
    const { addToast } = uiStore.getState();
    if (!task) {
      addToast('error', 'Open File', 'The selected download was not found.');
      return;
    }
    if (task.status !== 'completed') {
      addToast('warning', 'Download not complete', 'The download must finish before opening.');
      return;
    }
    if (!task.savePath) {
      addToast('error', 'Open File', 'No saved file path is available for this download.');
      return;
    }
    const opened = await tauriClient.openDownloadedFile(task.savePath);
    if (opened) addToast('success', 'File opened', `Opened "${task.name}".`);
    else addToast('error', 'File opened', `Could not open "${task.name}". The file may have moved.`);
  },

  openTaskLocation: async (id) => {
    const task = get().tasks.find((item) => item.id === id);
    const { addToast } = uiStore.getState();
    if (!task) {
      addToast('error', 'Open File Location', 'The selected download was not found.');
      return;
    }
    if (!task.savePath) {
      addToast('error', 'Open File Location', 'No saved file path is available for this download.');
      return;
    }
    const opened = await tauriClient.revealDownloadedFile(task.savePath);
    if (opened) addToast('success', 'Folder opened', `Opened location for "${task.name}".`);
    else addToast('error', 'Folder opened', `Could not open the location for "${task.name}".`);
  },

  renameTask: async (id, name) => {
    const targetItem = get().tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      uiStore.getState().addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return false;
    }
    try {
      const normalizedTask = { ...(await novaClient.updateDownload(id, { name })) };
      set((p) => ({ tasks: p.tasks.map((item) => (item.id === id ? normalizedTask : item)) }));
      uiStore.getState().addToast('success', 'Download renamed', `Renamed to "${normalizedTask.name}".`);
      return true;
    } catch (error) {
      uiStore
        .getState()
        .addToast(
          'error',
          'NOVA daemon',
          error instanceof Error ? error.message : 'The local engine could not rename the download.',
        );
      return false;
    }
  },

  redownloadTask: async (id) => {
    const targetItem = get().tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      uiStore.getState().addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return;
    }
    try {
      const normalizedTask = { ...(await novaClient.redownloadDownload(id)) };
      set((p) => ({ tasks: p.tasks.map((item) => (item.id === id ? normalizedTask : item)) }));
      uiStore
        .getState()
        .addToast('info', 'Re-download started', `"${normalizedTask.name}" will be downloaded again from scratch.`);
    } catch (error) {
      uiStore
        .getState()
        .addToast(
          'error',
          'NOVA daemon',
          error instanceof Error ? error.message : 'The local engine could not restart the download.',
        );
    }
  },

  refreshTaskLink: async (id, url) => {
    const targetItem = get().tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      uiStore.getState().addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return false;
    }
    try {
      const normalizedTask = { ...(await novaClient.updateDownload(id, { url })) };
      set((p) => ({ tasks: p.tasks.map((item) => (item.id === id ? normalizedTask : item)) }));
      return true;
    } catch (error) {
      uiStore
        .getState()
        .addToast(
          'error',
          'NOVA daemon',
          error instanceof Error ? error.message : 'The local engine could not update the download link.',
        );
      return false;
    }
  },

  updateTaskProperties: (id, updatedFields) => {
    set((p) => ({ tasks: p.tasks.map((item) => (item.id === id ? { ...item, ...updatedFields } : item)) }));
    uiStore.getState().addToast('success', 'Properties Updated', 'Download properties were updated successfully.');
  },

  triggerBatchDownload: async (urls, options) => {
    const { settings } = settingsStore.getState();
    const accepted: DownloadItem[] = [];
    for (const url of urls) {
      if (!url.trim()) continue;
      const parsedName = url.substring(url.lastIndexOf('/') + 1) || 'download';
      const targetDirectory = options?.saveDirectory || settings.saveAndCategories.categoryFolders.other || '';
      const task = await get().addTask(
        {
          name: parsedName,
          url,
          fileType: 'other',
          status: 'queued',
          sizeBytes: 0,
          category: 'other',
          queueId: options?.queueId || 'main',
          connections: options?.connections ?? 0,
          resumable: true,
          savePath: targetDirectory ? `${targetDirectory.replace(/[\\/]+$/, '')}\\${parsedName}` : parsedName,
          description: options?.description || 'Batch import',
          directOptions: options?.directOptions,
          elapsedSeconds: 0,
        },
        false,
      );
      if (task) accepted.push(task);
    }
    if (accepted.length > 0) {
      uiStore
        .getState()
        .addToast('success', 'Batch import', `${String(accepted.length)} link(s) were accepted by the local daemon.`);
    }
  },
}));
