/* src/state/useTaskStore.ts */
import React from 'react';
import { DownloadItem, AppSettings } from '../types/desktop-ui.types';
import { novaClient } from '../api/novaClient';

const isNativeEngineTask = (task: DownloadItem) =>
  task.engine === 'curl' || task.engine === 'libcurl-multi' || task.engine === 'yt-dlp';

const hydrateTask = (task: DownloadItem): DownloadItem => ({ ...task });

export const mergeDaemonTasks = (daemonTasks: DownloadItem[]) => daemonTasks.map(hydrateTask);

export function useTaskStore(
  tasks: DownloadItem[],
  setTasks: React.Dispatch<React.SetStateAction<DownloadItem[]>>,
  selectedTaskId: string | null,
  setSelectedTaskId: React.Dispatch<React.SetStateAction<string | null>>,
  bridgeStatus: string,
  addToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string) => void,
  openDialog: (active: string, payload?: unknown) => void,
  addTaskToQueueOrder: (taskId: string, queueId: string) => void,
  setIsDegradedMode: React.Dispatch<React.SetStateAction<boolean>>,
  settings: AppSettings,
) {
  const addTask = async (
    newItem: Omit<
      DownloadItem,
      'id' | 'dateAdded' | 'downloadedBytes' | 'speedBytesPerSec' | 'timeLeftSeconds' | 'segments'
    >,
    downloadImmediately: boolean,
  ): Promise<DownloadItem | null> => {
    if (bridgeStatus === 'connecting' || bridgeStatus === 'disconnected') {
      addToast('error', 'NOVA daemon unavailable', 'Start the local NOVA daemon before creating downloads.');
      return null;
    }

    try {
      const remoteTask = await novaClient.createDownload({ ...newItem, startImmediately: downloadImmediately });
      const normalizedTask = hydrateTask(remoteTask);
      setTasks((prev) => [normalizedTask, ...prev.filter((item) => item.id !== normalizedTask.id)]);
      setSelectedTaskId(normalizedTask.id);
      setIsDegradedMode(false);

      if (newItem.queueId) {
        addTaskToQueueOrder(normalizedTask.id, newItem.queueId);
      }

      addToast('success', 'Download added', `"${normalizedTask.name}" was added to the download queue.`);
      if (downloadImmediately) {
        openDialog('activeProgress', normalizedTask);
      }
      return normalizedTask;
    } catch (error) {
      setIsDegradedMode(true);
      addToast(
        'error',
        'NOVA daemon',
        error instanceof Error ? error.message : 'The local download engine rejected the task.',
      );
      return null;
    }
  };

  const pauseTask = async (id: string) => {
    const targetItem = tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return;
    }

    try {
      const normalizedTask = hydrateTask(await novaClient.pauseDownload(id));
      setTasks((prev) => prev.map((item) => (item.id === id ? normalizedTask : item)));
      addToast('info', 'Download stopped', `"${normalizedTask.name}" was stopped.`);
    } catch (error) {
      addToast(
        'error',
        'NOVA daemon',
        error instanceof Error ? error.message : 'The local engine could not stop the download.',
      );
    }
  };

  const resumeTask = async (id: string) => {
    const targetItem = tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return;
    }

    try {
      const normalizedTask = hydrateTask(await novaClient.resumeDownload(id));
      setTasks((prev) => prev.map((item) => (item.id === id ? normalizedTask : item)));
      if (normalizedTask.id !== id) {
        setSelectedTaskId(normalizedTask.id);
        if (normalizedTask.queueId) {
          addTaskToQueueOrder(normalizedTask.id, normalizedTask.queueId);
        }
      }
      addToast('info', 'Download resumed', `"${normalizedTask.name}" was resumed.`);
    } catch (error) {
      addToast(
        'error',
        'NOVA daemon',
        error instanceof Error ? error.message : 'The local engine could not resume the download.',
      );
    }
  };

  const deleteTask = async (id: string, deleteDisk: boolean) => {
    const targetItem = tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
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
      setTasks((prev) => prev.filter((t) => t.id !== id));
      if (selectedTaskId === id) setSelectedTaskId(null);
      addToast('warning', 'Download removed', `"${targetItem.name}" was removed from the daemon.${diskMessage}`);
    } catch (error) {
      addToast(
        'error',
        'NOVA daemon',
        error instanceof Error ? error.message : 'The local engine could not delete the download.',
      );
    }
  };

  const updateTaskProperties = (id: string, updatedFields: Partial<DownloadItem>) => {
    setTasks((prev) =>
      prev.map((item) => {
        if (item.id === id) {
          return { ...item, ...updatedFields };
        }
        return item;
      }),
    );
    addToast('success', 'Properties Updated', 'Download properties were updated successfully.');
  };

  const triggerBatchDownload = async (
    urls: string[],
    options?: {
      queueId?: string;
      connections?: number;
      saveDirectory?: string;
      description?: string;
      directOptions?: DownloadItem['directOptions'];
    },
  ) => {
    const accepted: DownloadItem[] = [];
    for (const url of urls) {
      if (!url.trim()) continue;
      const parsedName = url.substring(url.lastIndexOf('/') + 1) || 'download';
      const targetDirectory = options?.saveDirectory || settings.saveAndCategories.categoryFolders.other || '';
      const task = await addTask(
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
        },
        false,
      );
      if (task) accepted.push(task);
    }
    if (accepted.length > 0) {
      addToast('success', 'Batch import', `${String(accepted.length)} link(s) were accepted by the local daemon.`);
    }
  };

  return {
    addTask,
    pauseTask,
    resumeTask,
    deleteTask,
    updateTaskProperties,
    triggerBatchDownload,
  };
}
