import { create } from 'zustand';
import type { DownloadItem } from '../types/desktop-ui.types';
import { novaClient } from '../api/novaClient';
import { tauriClient } from '../api/tauriClient';
import { bridgeStore } from './bridgeStore';
import { extractErrorMessage } from '../utils/formatUtils';
import { logger } from '../utils/logger';
import { playAppSound } from '../utils/sound';
import { uiStore } from './uiStore';
import { queueStore } from './queueStore';
import { settingsStore } from './settingsStore';
import { useEngineStore } from './engineStore';

const isNativeEngineTask = (task: DownloadItem) =>
  task.engine === 'curl' || task.engine === 'libcurl-multi' || task.engine === 'yt-dlp';

// Cap concurrent createDownload calls when importing a large batch so a 10k-URL
// batch doesn't serialize every round-trip through the daemon one at a time.
const MAX_BATCH_CONCURRENCY = 8;

/**
 * Merge daemon tasks into the local store, preserving object identity for
 * tasks that haven't changed since the last sync. This is critical for
 * rendering performance: components subscribed via useShallow(useTaskData)
 * only re-render when actual task data changes, not on every 2-second poll.
 */
export const mergeDaemonTasks = (daemonTasks: DownloadItem[]): DownloadItem[] => {
  const prev = taskStore.getState().tasks;
  if (daemonTasks === prev) return prev;

  const prevMap = new Map<string, DownloadItem>();
  for (const t of prev) prevMap.set(t.id, t);

  let unchanged = prev.length === daemonTasks.length;
  const merged = new Array<DownloadItem>(daemonTasks.length);
  for (let i = 0; i < daemonTasks.length; i++) {
    const task = daemonTasks[i];
    const existing = prevMap.get(task.id);
    if (existing && shallowEqualTask(existing, task)) {
      merged[i] = existing;
      if (existing !== prev[i]) unchanged = false;
    } else {
      merged[i] = { ...task };
      unchanged = false;
    }
  }
  // When nothing changed, return the previous array by reference so callers
  // (appStore) can skip setTasks entirely and avoid waking every subscriber
  // (TaskTable sort/filter, sidebar counts) on every 2-second poll.
  return unchanged ? prev : merged;
};

/** Compare two tasks for shallow equality (the fields that change during
 *  download progress). If all relevant fields match, we reuse the old
 *  reference to prevent unnecessary React re-renders. */
function shallowEqualTask(a: DownloadItem, b: DownloadItem): boolean {
  if (
    a.status !== b.status ||
    a.downloadedBytes !== b.downloadedBytes ||
    a.speedBytesPerSec !== b.speedBytesPerSec ||
    a.sizeBytes !== b.sizeBytes ||
    a.timeLeftSeconds !== b.timeLeftSeconds ||
    a.elapsedSeconds !== b.elapsedSeconds ||
    a.engineStatus !== b.engineStatus ||
    a.errorMessage !== b.errorMessage ||
    a.name !== b.name ||
    a.url !== b.url ||
    a.fileType !== b.fileType ||
    a.dateAdded !== b.dateAdded ||
    a.completedAt !== b.completedAt ||
    a.category !== b.category ||
    a.queueId !== b.queueId ||
    a.connections !== b.connections ||
    a.resumable !== b.resumable ||
    a.savePath !== b.savePath ||
    a.description !== b.description ||
    a.referer !== b.referer ||
    a.engine !== b.engine ||
    a.engineId !== b.engineId ||
    a.retries !== b.retries ||
    JSON.stringify(a.mediaOptions) !== JSON.stringify(b.mediaOptions) ||
    JSON.stringify(a.directOptions) !== JSON.stringify(b.directOptions)
  ) {
    return false;
  }
  if (a.segments.length !== b.segments.length) return false;
  for (let i = 0; i < a.segments.length; i++) {
    const sa = a.segments[i];
    const sb = b.segments[i];
    if (
      sa.id !== sb.id ||
      sa.progress !== sb.progress ||
      sa.downloadedBytes !== sb.downloadedBytes ||
      sa.totalBytes !== sb.totalBytes ||
      sa.active !== sb.active ||
      sa.speed !== sb.speed
    ) {
      return false;
    }
  }
  return true;
}

export interface BatchDownloadResult {
  attemptedCount: number;
  acceptedCount: number;
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
    silent?: boolean,
    captureReviewId?: string,
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
  ) => Promise<BatchDownloadResult>;
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

  addTask: async (newItem, downloadImmediately, silent = false, captureReviewId) => {
    const { status: bridgeStatus } = bridgeStore.getState();
    if (bridgeStatus === 'connecting' || bridgeStatus === 'disconnected') {
      uiStore
        .getState()
        .addToast('error', 'NOVA daemon unavailable', 'Start the local NOVA daemon before creating downloads.');
      return null;
    }
    try {
      logger.info('TaskStore', `Creating download: ${newItem.url}`, { name: newItem.name, engine: newItem.engine });
      const payload = { ...newItem, startImmediately: downloadImmediately };
      const normalizedTask = {
        ...(captureReviewId
          ? await novaClient.createDownloadFromCaptureReview(captureReviewId, payload)
          : await novaClient.createDownload(payload)),
      };
      set((p) => ({ tasks: [normalizedTask, ...p.tasks.filter((item) => item.id !== normalizedTask.id)] }));
      uiStore.getState().setSelectedTaskId(normalizedTask.id);
      bridgeStore.getState().setIsDegradedMode(false);
      if (newItem.queueId) queueStore.getState().addTaskToQueueOrder(normalizedTask.id, newItem.queueId);
      // Batch imports pass silent=true so a 10k-URL batch doesn't fire 10k
      // toasts (each scheduling its own auto-dismiss timer).
      if (!silent) {
        uiStore
          .getState()
          .addToast('success', 'Download added', `"${normalizedTask.name}" was added to the download queue.`);
      }
      if (downloadImmediately) {
        playAppSound(settingsStore.getState().settings, 'start');
        uiStore.getState().openDialog('activeProgress', normalizedTask);
      }
      return normalizedTask;
    } catch (error) {
      logger.error('TaskStore', `Failed to create download: ${newItem.url}`, {
        error: extractErrorMessage(error, 'Unknown error'),
      });
      bridgeStore.getState().setIsDegradedMode(true);
      uiStore
        .getState()
        .addToast('error', 'NOVA daemon', extractErrorMessage(error, 'The local download engine rejected the task.'));
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
      logger.info('TaskStore', `Pausing download: ${targetItem.name}`, { id });
      const normalizedTask = { ...(await novaClient.pauseDownload(id)) };
      set((p) => ({ tasks: p.tasks.map((item) => (item.id === id ? normalizedTask : item)) }));
      uiStore.getState().addToast('info', 'Download stopped', `"${normalizedTask.name}" was stopped.`);
    } catch (error) {
      logger.error('TaskStore', `Failed to pause download ${id}`, {
        error: extractErrorMessage(error, 'Unknown error'),
      });
      uiStore
        .getState()
        .addToast('error', 'NOVA daemon', extractErrorMessage(error, 'The local engine could not stop the download.'));
    }
  },

  resumeTask: async (id) => {
    const targetItem = get().tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      uiStore.getState().addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return;
    }
    try {
      logger.info('TaskStore', `Resuming download: ${targetItem.name}`, { id });
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
          extractErrorMessage(error, 'The local engine could not resume the download.'),
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
      logger.info('TaskStore', `Deleting download: ${targetItem.name}`, { id, deleteDisk });
      await novaClient.deleteDownload(id, deleteDisk);
      let diskMessage = '';
      if (deleteDisk) {
        diskMessage = targetItem.savePath
          ? ' The daemon also deleted the local file and libcurl partial segments when present.'
          : ' No saved file path was available for disk deletion.';
      }
      set((p) => ({ tasks: p.tasks.filter((t) => t.id !== id) }));
      if (uiStore.getState().selectedTaskId === id) uiStore.getState().setSelectedTaskId(null);
      // Clean up per-task telemetry to prevent unbounded memory growth.
      useEngineStore.getState().removeTaskTelemetry(id);
      // Prune the id from every queue's downloadOrder so stale ids never
      // accumulate unboundedly across many add/delete cycles.
      queueStore.getState().removeTaskFromQueue(id);
      uiStore
        .getState()
        .addToast('warning', 'Download removed', `"${targetItem.name}" was removed from the daemon.${diskMessage}`);
    } catch (error) {
      uiStore
        .getState()
        .addToast(
          'error',
          'NOVA daemon',
          extractErrorMessage(error, 'The local engine could not delete the download.'),
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
          extractErrorMessage(error, 'The local engine could not rename the download.'),
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
          extractErrorMessage(error, 'The local engine could not restart the download.'),
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
          extractErrorMessage(error, 'The local engine could not update the download link.'),
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
    const attemptedCount = urls.reduce((count, url) => count + (url.trim() ? 1 : 0), 0);
    let nextUrl = 0;
    const worker = async () => {
      while (nextUrl < urls.length) {
        const url = urls[nextUrl];
        nextUrl += 1;
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
          true, // silent: no per-task toasts for batch imports
        );
        if (task) accepted.push(task);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_BATCH_CONCURRENCY, urls.length) }, () => worker()));
    if (accepted.length > 0) {
      uiStore
        .getState()
        .addToast('success', 'Batch import', `${String(accepted.length)} link(s) were accepted by the local daemon.`);
    }
    return { attemptedCount, acceptedCount: accepted.length };
  },
}));
