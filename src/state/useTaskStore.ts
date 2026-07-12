/* src/state/useTaskStore.ts */
import React from 'react';
import { DownloadItem, AppSettings } from '../types/desktop-ui.types';
import { novaClient } from '../api/novaClient';
import { getTranslation } from '../lib/i18n/translations';

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
  const lang = settings.extra.language || 'en';
  const t = (key: string, params?: Record<string, string | number>) =>
    getTranslation(lang, key, params);

  const addTask = async (
    newItem: Omit<
      DownloadItem,
      'id' | 'dateAdded' | 'downloadedBytes' | 'speedBytesPerSec' | 'timeLeftSeconds' | 'segments'
    >,
    downloadImmediately: boolean,
  ): Promise<DownloadItem | null> => {
    if (bridgeStatus === 'connecting' || bridgeStatus === 'disconnected') {
      addToast('error', t('toast_daemon_unavailable_title'), t('toast_daemon_start_first'));
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

      addToast('success', t('toast_download_added_title'), t('toast_download_added_desc', { name: normalizedTask.name }));
      if (downloadImmediately) {
        openDialog('activeProgress', normalizedTask);
      }
      return normalizedTask;
    } catch (error) {
      setIsDegradedMode(true);
      addToast(
        'error',
        t('toast_daemon_unavailable_title'),
        error instanceof Error ? error.message : t('toast_engine_error_default'),
      );
      return null;
    }
  };

  const pauseTask = async (id: string) => {
    const targetItem = tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      addToast('error', t('toast_daemon_unavailable_title'), t('toast_engine_not_native'));
      return;
    }

    try {
      const normalizedTask = hydrateTask(await novaClient.pauseDownload(id));
      setTasks((prev) => prev.map((item) => (item.id === id ? normalizedTask : item)));
      addToast('info', t('toast_download_stopped_title'), t('toast_download_stopped_desc', { name: normalizedTask.name }));
    } catch (error) {
      addToast(
        'error',
        t('toast_daemon_unavailable_title'),
        error instanceof Error ? error.message : t('toast_engine_stop_error'),
      );
    }
  };

  const resumeTask = async (id: string) => {
    const targetItem = tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      addToast('error', t('toast_daemon_unavailable_title'), t('toast_engine_not_native'));
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
      addToast('info', t('toast_download_resumed_title'), t('toast_download_resumed_desc', { name: normalizedTask.name }));
    } catch (error) {
      addToast(
        'error',
        t('toast_daemon_unavailable_title'),
        error instanceof Error ? error.message : t('toast_engine_resume_error'),
      );
    }
  };

  const deleteTask = async (id: string, deleteDisk: boolean) => {
    const targetItem = tasks.find((t) => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      addToast('error', t('toast_daemon_unavailable_title'), t('toast_engine_not_native'));
      return;
    }

    try {
      await novaClient.deleteDownload(id, deleteDisk);
      let diskMessage = '';
      if (deleteDisk) {
        diskMessage = targetItem.savePath
          ? t('toast_download_removed_disk_msg')
          : t('toast_download_removed_no_path');
      }
      setTasks((prev) => prev.filter((t) => t.id !== id));
      if (selectedTaskId === id) setSelectedTaskId(null);
      addToast('warning', t('toast_download_removed_title'), t('toast_download_removed_desc', { name: targetItem.name }) + diskMessage);
    } catch (error) {
      addToast(
        'error',
        t('toast_daemon_unavailable_title'),
        error instanceof Error ? error.message : t('toast_engine_delete_error'),
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
    addToast('success', t('toast_props_updated_title'), t('toast_props_updated_desc'));
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
      addToast('success', t('toast_batch_import_title'), t('toast_batch_import_desc', { count: accepted.length }));
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
