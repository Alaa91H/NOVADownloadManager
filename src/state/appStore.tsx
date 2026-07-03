/* src/state/appStore.tsx */
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import {
   DownloadItem,
   Queue,
   AppSettings,
   AppThemeSettings,
   ToastItem,
   DialogState,
   FileType
} from '../types/desktop-ui.types';
import {
   initialQueues,
   initialSettings
} from '../initialData';
import { tauriClient, getDaemonUrl } from '../api/tauriClient';
import { novaClient, setApiBase } from '../api/novaClient';
import { getTranslation, isLanguageLoaded, loadLanguage } from '../lib/i18n/translations';

interface AppStoreContextType {
  tasks: DownloadItem[];
  queues: Queue[];
  selectedTaskId: string | null;
  workspaceView: 'all' | 'unfinished' | 'finished' | 'queued' | FileType | 'browser' | 'scheduler' | 'diagnostics';
  bridge: {
    status: 'connected' | 'connecting' | 'disconnected' | 'degraded';
    version: string;
    pid: number;
    uptime: number;
    speedLimit: number | null;
  };
  searchQuery: string;
  dialog: DialogState;
  settings: AppSettings;
  themeSettings: AppThemeSettings;
  toasts: ToastItem[];
  isLoading: boolean;
  isDegradedMode: boolean;
  isNotificationsMuted: boolean;
  setIsNotificationsMuted: (muted: boolean) => void;
  updatingTaskId: string | null;
  setUpdatingTaskId: (id: string | null) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  activeProgressMinimizedToTaskbar: boolean;
  setActiveProgressMinimizedToTaskbar: (minimized: boolean) => void;
  minimizedProgressTask: DownloadItem | null;
  setMinimizedProgressTask: (task: DownloadItem | null) => void;
  
  // Actions
  setWorkspaceView: (view: 'all' | 'unfinished' | 'finished' | 'queued' | FileType | 'browser' | 'scheduler' | 'diagnostics') => void;
  setSearchQuery: (query: string) => void;
  setSelectedTaskId: (id: string | null) => void;
  addTask: (task: Omit<DownloadItem, 'id' | 'dateAdded' | 'downloadedBytes' | 'speedBytesPerSec' | 'timeLeftSeconds' | 'segments'>, downloadImmediately: boolean) => Promise<DownloadItem | null>;
  pauseTask: (id: string) => void;
  resumeTask: (id: string) => void;
  deleteTask: (id: string, deleteDisk: boolean) => void;
  updateTaskProperties: (id: string, updatedFields: Partial<DownloadItem>) => void;
  updateQueue: (id: string, updatedQueue: Partial<Queue>, silent?: boolean) => void;
  addQueue: (name: string) => void;
  deleteQueue: (id: string) => void;
  removeTaskFromQueue: (taskId: string) => void;
  moveTaskToQueue: (taskId: string, targetQueueId: string) => void;
  createQueueAndMoveTask: (queueName: string, taskId: string) => void;
  updateSettings: (updatedSettings: AppSettings, silent?: boolean) => void;
  updateThemeSettings: (key: keyof AppThemeSettings, value: string) => void;
  openDialog: (active: string, payload?: any) => void;
  closeDialog: () => void;
  addToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string) => void;
  removeToast: (id: string) => void;
  triggerBatchDownload: (
    urls: string[],
    options?: {
      queueId?: string;
      connections?: number;
      saveDirectory?: string;
      description?: string;
      directOptions?: DownloadItem['directOptions'];
    }
  ) => Promise<void>;
}

const AppStoreContext = createContext<AppStoreContextType | undefined>(undefined);

const isNativeEngineTask = (task: DownloadItem) => task.engine === 'aria2' || task.engine === 'yt-dlp';

const hydrateTask = (task: DownloadItem): DownloadItem => ({
  ...task
});

const mergeDaemonTasks = (daemonTasks: DownloadItem[]) => daemonTasks.map(hydrateTask);

const createLocalId = (prefix: string) => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}`;
};

const generateBrowserPairingToken = () => {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
    return `nova_token_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return `nova_token_${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;
};

const ensureBrowserPairingToken = (settings: AppSettings): AppSettings => {
  if (settings.extra.browserPairingToken) return settings;
  return {
    ...settings,
    extra: {
      ...settings.extra,
      browserPairingToken: generateBrowserPairingToken()
    }
  };
};

export const AppStoreProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [tasks, setTasks] = useState<DownloadItem[]>([]);
  const [queues, setQueues] = useState<Queue[]>(() => {
    const cached = localStorage.getItem('nova_queues');
    return cached ? JSON.parse(cached) : initialQueues;
  });
  const [settings, setSettings] = useState<AppSettings>(() => {
    const cached = localStorage.getItem('nova_settings_v1');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return ensureBrowserPairingToken({
          ...initialSettings,
          ...parsed,
          general: {
            ...initialSettings.general,
            ...(parsed.general || {})
          },
          connection: {
            ...initialSettings.connection,
            ...(parsed.connection || {})
          },
          saveAndCategories: {
            ...initialSettings.saveAndCategories,
            ...(parsed.saveAndCategories && parsed.saveAndCategories.defaultFolder && parsed.saveAndCategories.defaultFolder.includes('NOVA') ? parsed.saveAndCategories : {})
          },
          sounds: {
            ...initialSettings.sounds,
            ...(parsed.sounds || {})
          },
          advanced: {
            ...initialSettings.advanced,
            ...(parsed.advanced || {})
          },
          extra: {
            ...initialSettings.extra,
            ...(parsed.extra || {})
          }
        });
      } catch (e) {
        return ensureBrowserPairingToken(initialSettings);
      }
    }
    return ensureBrowserPairingToken(initialSettings);
  });
  const [themeSettings, setThemeSettings] = useState<AppThemeSettings>(() => {
    const cached = localStorage.getItem('nova_theme_settings_v1');
    let parsed = {
      theme: 'dark',
      density: 'compact',
      accent: 'blue',
      sidebar: 'expanded',
      progress: 'bar',
      contrast: 'normal',
      motion: 'enabled',
      blur: 'enabled'
    };
    if (cached) {
      try { parsed = { ...parsed, ...JSON.parse(cached) }; } catch(e){}
    }
    // Force dark theme everywhere
    parsed.theme = 'dark';
    return parsed;
  });

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<'all' | 'unfinished' | 'finished' | 'queued' | FileType | 'browser' | 'scheduler' | 'diagnostics'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dialog, setDialog] = useState<DialogState>({ active: null });
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDegradedMode, setIsDegradedMode] = useState(false);
  const [isNotificationsMuted, setIsNotificationsMuted] = useState<boolean>(() => {
    const cached = localStorage.getItem('nova_notifications_muted');
    return cached === 'true';
  });

  const [activeProgressMinimizedToTaskbar, setActiveProgressMinimizedToTaskbar] = useState<boolean>(false);
  const [minimizedProgressTask, setMinimizedProgressTask] = useState<DownloadItem | null>(null);

  const [bridge, setBridge] = useState({
    status: 'connecting' as 'connected' | 'connecting' | 'disconnected' | 'degraded',
    version: '',
    pid: 0,
    uptime: 0,
    speedLimit: null as number | null
  });
  const [i18nRevision, setI18nRevision] = useState(0);

  // Languages are code-split; fetch the active one on demand. English is
  // always bundled, so the UI renders immediately and re-renders once the
  // requested language chunk arrives.
  useEffect(() => {
    const lang = settings.extra.language || 'en';
    if (isLanguageLoaded(lang)) return;
    let cancelled = false;
    void loadLanguage(lang).then(() => {
      if (!cancelled) setI18nRevision(revision => revision + 1);
    });
    return () => { cancelled = true; };
  }, [settings.extra.language]);

  // Apply visual design parameters dynamically on the root document element (As requested by the user!)
  useEffect(() => {
    const root = document.documentElement;
    
    const updateTheme = () => {
      let activeTheme = themeSettings.theme;
      if (activeTheme === 'system') {
        activeTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      root.setAttribute('data-theme', activeTheme);
    };

    updateTheme();

    root.setAttribute('data-density', themeSettings.density);
    root.setAttribute('data-accent', themeSettings.accent);
    root.setAttribute('data-sidebar', themeSettings.sidebar);
    root.setAttribute('data-progress', themeSettings.progress);
    root.setAttribute('data-contrast', themeSettings.contrast);
    root.setAttribute('data-motion', themeSettings.motion);
    root.setAttribute('data-blur', themeSettings.blur);
    root.setAttribute('dir', 'ltr');
    const currentLang = settings?.extra?.language || 'en';
    root.setAttribute('lang', currentLang);

    if (themeSettings.theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => updateTheme();
      mediaQuery.addEventListener('change', listener);
      return () => mediaQuery.removeEventListener('change', listener);
    }
  }, [themeSettings, settings?.extra?.language]);

  useEffect(() => {
    localStorage.setItem('nova_queues', JSON.stringify(queues));
  }, [queues]);

  useEffect(() => {
    localStorage.setItem('nova_settings_v1', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem('nova_theme_settings_v1', JSON.stringify(themeSettings));
  }, [themeSettings]);

  useEffect(() => {
    localStorage.setItem('nova_notifications_muted', String(isNotificationsMuted));
  }, [isNotificationsMuted]);

  // Connect to the local NOVA daemon on startup
  useEffect(() => {
    let cancelled = false;
    let restartAttempted = false;
    const connectDaemon = async (): Promise<void> => {
      // Resolve the correct daemon URL (especially important in Tauri where
      // the port may differ from the default 3199).
      const daemonUrl = await getDaemonUrl();
      setApiBase(daemonUrl);

      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (cancelled) return;
        try {
          const info = await tauriClient.checkDaemonHealth();
          if (cancelled) return;
          setIsDegradedMode(false);
          setBridge({
            status: 'connected',
            version: info.buildVersion || info.version,
            pid: info.pid,
            uptime: 1,
            speedLimit: settings.connection.speedLimiter.enabled ? settings.connection.speedLimiter.maxSpeedKbs : null
          });
          addToast('success', 'Service Connected', 'NOVA connected to the local download service successfully.');
          return;
        } catch (e) {
          if (cancelled) return;
          if (!restartAttempted && attempt >= 3) {
            restartAttempted = true;
            const restarted = await tauriClient.restartDaemon();
            if (restarted) {
              await new Promise(r => setTimeout(r, 1500));
              continue;
            }
          }
          if (attempt < 29) {
            await new Promise(r => setTimeout(r, 1000));
          } else {
            setBridge(b => ({ ...b, status: 'degraded', version: 'NOVA daemon unavailable' }));
            setIsDegradedMode(true);
            setTasks([]);
            addToast('warning', 'NOVA daemon unavailable', e instanceof Error ? e.message : 'The local download engines are not available.');
          }
        }
      }
    };
    connectDaemon();
    return () => { cancelled = true; };
  }, []);

  // Daemon Uptime counter tick. Skipped while the window is hidden in the
  // tray (a per-second setState re-renders the whole tree for no visible UI);
  // the timestamp keeps the counter accurate when the window comes back.
  useEffect(() => {
    if (bridge.status !== 'connected') return;
    const connectedAt = Date.now() - bridge.uptime * 1000;
    const interval = setInterval(() => {
      if (document.hidden) return;
      setBridge(b => ({ ...b, uptime: Math.round((Date.now() - connectedAt) / 1000) }));
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge.status]);

  useEffect(() => {
    if (bridge.status !== 'connected') return;

    const enabled = Object.values(settings.general.integrateWithBrowsers).some(Boolean);
    void novaClient.configureBrowserExtension({
      enabled,
      token: settings.extra.browserPairingToken,
      minSizeMb: settings.fileTypes.autoDownloadMaxSizeMb,
      defaultFolder: settings.saveAndCategories.defaultFolder,
      categoryFolders: settings.saveAndCategories.categoryFolders,
      userAgent: settings.extra.userAgent
    }).catch(() => {
      // The bridge will be synced again on the next successful daemon connection.
    });
  }, [
    bridge.status,
    settings.general.integrateWithBrowsers,
    settings.extra.browserPairingToken,
    settings.fileTypes.autoDownloadMaxSizeMb,
    settings.saveAndCategories.defaultFolder,
    settings.saveAndCategories.categoryFolders,
    settings.extra.userAgent
  ]);

  // Sync live aria2 / yt-dlp tasks from the NOVA daemon.
  useEffect(() => {
    if (bridge.status !== 'connected') return;

    let cancelled = false;
    const syncDownloads = async () => {
      try {
        const daemonTasks = await novaClient.listDownloads();
        if (cancelled) return;
        setTasks(mergeDaemonTasks(daemonTasks));
        setIsDegradedMode(false);
      } catch (e) {
        if (!cancelled) {
          setBridge(b => ({ ...b, status: 'degraded' }));
          setIsDegradedMode(true);
        }
      }
    };

    syncDownloads();
    // Downloads keep running in the daemon; the poll only feeds the UI, so it
    // pauses while the window is hidden and refreshes as soon as it is shown.
    const interval = setInterval(() => {
      if (document.hidden) return;
      void syncDownloads();
    }, 1000);
    const onVisibilityChange = () => {
      if (!document.hidden) void syncDownloads();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [bridge.status]);

  // Actions implementations
  const addToast = (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string) => {
    if (isNotificationsMuted) return;
    const id = createLocalId('toast');
    setToasts(prev => [...prev, { id, type, title, message }]);
    setTimeout(() => {
      removeToast(id);
    }, 4500);
  };

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const openDialog = (active: string, payload?: any) => {
    if (active === 'activeProgress') {
      setActiveProgressMinimizedToTaskbar(false);
      setMinimizedProgressTask(null);
    }
    setDialog({ active, payload });
  };

  const closeDialog = () => {
    setActiveProgressMinimizedToTaskbar(false);
    setMinimizedProgressTask(null);
    setDialog({ active: null });
  };

  const addTask = async (
    newItem: Omit<DownloadItem, 'id' | 'dateAdded' | 'downloadedBytes' | 'speedBytesPerSec' | 'timeLeftSeconds' | 'segments'>,
    downloadImmediately: boolean
  ): Promise<DownloadItem | null> => {
    if (bridge.status !== 'connected') {
      addToast('error', 'NOVA daemon unavailable', 'Start the local NOVA daemon before creating downloads.');
      return null;
    }

    try {
      const remoteTask = await novaClient.createDownload({ ...newItem, startImmediately: downloadImmediately });
      const normalizedTask = hydrateTask(remoteTask);
      setTasks(prev => [normalizedTask, ...prev.filter(item => item.id !== normalizedTask.id)]);
      setSelectedTaskId(normalizedTask.id);
      setIsDegradedMode(false);

      if (newItem.queueId) {
        setQueues(prev => prev.map(q => {
          if (q.id !== newItem.queueId || q.downloadOrder.includes(normalizedTask.id)) return q;
          return { ...q, downloadOrder: [...q.downloadOrder, normalizedTask.id] };
        }));
      }

      addToast('success', 'Download added', `"${normalizedTask.name}" was added to the download queue.`);
      if (downloadImmediately) {
        openDialog('activeProgress', normalizedTask);
      }
      return normalizedTask;
    } catch (error) {
      setIsDegradedMode(true);
      addToast('error', 'NOVA daemon', error instanceof Error ? error.message : 'The local download engine rejected the task.');
      return null;
    }
  };
  const pauseTask = async (id: string) => {
    const targetItem = tasks.find(t => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return;
    }

    try {
      const normalizedTask = hydrateTask(await novaClient.pauseDownload(id));
      setTasks(prev => prev.map(item => item.id === id ? normalizedTask : item));
      addToast('info', 'Download paused', `"${normalizedTask.name}" was paused.`);
    } catch (error) {
      addToast('error', 'NOVA daemon', error instanceof Error ? error.message : 'The local engine could not pause the download.');
    }
  };
  const resumeTask = async (id: string) => {
    const targetItem = tasks.find(t => t.id === id);
    if (!targetItem || !isNativeEngineTask(targetItem)) {
      addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return;
    }

    try {
      const normalizedTask = hydrateTask(await novaClient.resumeDownload(id));
      setTasks(prev => prev.map(item => item.id === id ? normalizedTask : item));
      addToast('info', 'Download resumed', `"${normalizedTask.name}" was resumed.`);
    } catch (error) {
      addToast('error', 'NOVA daemon', error instanceof Error ? error.message : 'The local engine could not resume the download.');
    }
  };
  const deleteTask = async (id: string, deleteDisk: boolean) => {
    const targetItem = tasks.find(t => t.id === id);
    if (!targetItem) return;

    if (!isNativeEngineTask(targetItem)) {
      addToast('error', 'NOVA daemon', 'This task is not backed by a real download engine.');
      return;
    }

    try {
      await novaClient.deleteDownload(id);
      setTasks(prev => prev.filter(t => t.id !== id));
      if (selectedTaskId === id) setSelectedTaskId(null);
      addToast('warning', 'Download removed', `"${targetItem.name}" was removed from the daemon${deleteDisk ? '; local file deletion is not implemented yet' : ''}.`);
    } catch (error) {
      addToast('error', 'NOVA daemon', error instanceof Error ? error.message : 'The local engine could not delete the download.');
    }
  };
  const updateTaskProperties = (id: string, updatedFields: Partial<DownloadItem>) => {
    setTasks(prev => prev.map(item => {
      if (item.id === id) {
        return { ...item, ...updatedFields };
      }
      return item;
    }));
    addToast('success', 'Properties Updated', 'Download properties were updated successfully.');
  };

  const updateQueue = (id: string, updatedQueue: Partial<Queue>, silent?: boolean) => {
    setQueues(prev => prev.map(q => {
      if (q.id === id) {
        return { ...q, ...updatedQueue };
      }
      return q;
    }));
    if (!silent) {
      addToast('success', 'Queue Updated', 'Queue settings were saved successfully.');
    }
  };

  const addQueue = (name: string) => {
    const id = createLocalId('q');
    const newQueue: Queue = {
      id,
      name,
      active: false,
      scheduled: false,
      startTime: '02:00',
      endTime: '08:00',
      days: [0, 1, 2, 3, 4, 5, 6],
      limitSpeed: false,
      speedLimitKbs: 1024,
      oneTimeLimit: false,
      shutdownOnComplete: false,
      hangupOnComplete: false,
      retryCount: 3,
      downloadOrder: []
    };
    setQueues(prev => [...prev, newQueue]);
    addToast('success', 'Queue Created', `Download queue "${name}" was added successfully.`);
  };

  const deleteQueue = (id: string) => {
    if (id === 'main') {
      addToast('error', 'Delete Error', 'The default main queue cannot be deleted.');
      return;
    }
    const targetQueue = queues.find(q => q.id === id);
    if (!targetQueue) return;

    setQueues(prev => prev.filter(q => q.id !== id));
    // Reassign tasks to main queue
    setTasks(prev => prev.map(t => {
      if (t.queueId === id) {
        return { ...t, queueId: 'main' };
      }
      return t;
    }));

    addToast('warning', 'Queue Deleted', `Queue "${targetQueue.name}" was deleted and its files were moved to the main queue.`);
  };

  const removeTaskFromQueue = (taskId: string) => {
    const targetTask = tasks.find(t => t.id === taskId);
    if (!targetTask) return;

    setTasks(prev => prev.map(t => {
      if (t.id === taskId) {
        return { ...t, queueId: 'main' };
      }
      return t;
    }));

    // Remove from all queues downloadOrders
    setQueues(prev => prev.map(q => {
      const order = q.downloadOrder.filter(id => id !== taskId);
      return { ...q, downloadOrder: order };
    }));

    addToast('info', 'Removed from Queue', `"${targetTask.name}" was moved to the main queue.`);
  };

  const moveTaskToQueue = (taskId: string, targetQueueId: string) => {
    // Update task's queueId
    setTasks(prev => prev.map(t => {
      if (t.id === taskId) {
        return { ...t, queueId: targetQueueId };
      }
      return t;
    }));

    // Update queues' download orders
    setQueues(prev => prev.map(q => {
      let order = q.downloadOrder.filter(id => id !== taskId);
      if (q.id === targetQueueId) {
        if (!order.includes(taskId)) {
          order = [...order, taskId];
        }
      }
      return { ...q, downloadOrder: order };
    }));

    const targetQueue = queues.find(q => q.id === targetQueueId);
    const queueName = targetQueue ? targetQueue.name : 'selected queue';
    addToast('success', 'File Moved', `The file was moved to "${queueName}".`);
  };

  const createQueueAndMoveTask = (queueName: string, taskId: string) => {
    const newQueueId = createLocalId('q');
    const newQueue: Queue = {
      id: newQueueId,
      name: queueName,
      active: false,
      scheduled: false,
      startTime: '02:00',
      endTime: '08:00',
      days: [0, 1, 2, 3, 4, 5, 6],
      limitSpeed: false,
      speedLimitKbs: 1024,
      oneTimeLimit: false,
      shutdownOnComplete: false,
      hangupOnComplete: false,
      retryCount: 3,
      downloadOrder: [taskId]
    };

    setQueues(prev => [...prev, newQueue]);
    setTasks(prev => prev.map(t => {
      if (t.id === taskId) {
        return { ...t, queueId: newQueueId };
      }
      return t;
    }));

    addToast('success', 'Queue Created', `Queue "${queueName}" was created and the file was moved into it.`);
  };

  const updateSettings = (updatedSettings: AppSettings, silent = false) => {
    setSettings(updatedSettings);
    tauriClient.saveConfigToDisk(updatedSettings);
    if (!silent) {
      addToast('success', 'Settings Saved', 'Preferences and settings were saved.');
    }
  };

  const updateThemeSettings = (key: keyof AppThemeSettings, value: string) => {
    setThemeSettings(prev => ({ ...prev, [key]: value }));
  };

  const triggerBatchDownload = async (
    urls: string[],
    options?: {
      queueId?: string;
      connections?: number;
      saveDirectory?: string;
      description?: string;
      directOptions?: DownloadItem['directOptions'];
    }
  ) => {
    const accepted: DownloadItem[] = [];
    for (const url of urls) {
      if (!url.trim()) continue;
      const parsedName = url.substring(url.lastIndexOf('/') + 1) || 'download';
      const targetDirectory = options?.saveDirectory || settings.saveAndCategories.categoryFolders.other || '';
      const task = await addTask({
        name: parsedName,
        url,
        fileType: 'other',
        status: 'queued',
        sizeBytes: 0,
        category: 'other',
        queueId: options?.queueId || 'main',
        connections: options?.connections ?? 0,
        resumable: true,
        savePath: targetDirectory
          ? `${targetDirectory.replace(/[\\/]+$/, '')}\\${parsedName}`
          : parsedName,
        description: options?.description || 'Batch import',
        directOptions: options?.directOptions
      }, false);
      if (task) accepted.push(task);
    }
    if (accepted.length > 0) {
      addToast('success', 'Batch import', `${accepted.length} link(s) were accepted by the local daemon.`);
    }
  };
  const t = (key: string, params?: Record<string, string | number>) => {
    void i18nRevision;
    return getTranslation(settings.extra.language || 'en', key, params);
  };

  return (
    <AppStoreContext.Provider value={{
      tasks,
      queues,
      selectedTaskId,
      workspaceView,
      bridge,
      searchQuery,
      dialog,
      settings,
      themeSettings,
      toasts,
      isLoading,
      isDegradedMode,
      isNotificationsMuted,
      setIsNotificationsMuted,
      updatingTaskId,
      setUpdatingTaskId,
      t,
      activeProgressMinimizedToTaskbar,
      setActiveProgressMinimizedToTaskbar,
      minimizedProgressTask,
      setMinimizedProgressTask,
      setWorkspaceView,
      setSearchQuery,
      setSelectedTaskId,
      addTask,
      pauseTask,
      resumeTask,
      deleteTask,
      updateTaskProperties,
      updateQueue,
      addQueue,
      deleteQueue,
      removeTaskFromQueue,
      moveTaskToQueue,
      createQueueAndMoveTask,
      updateSettings,
      updateThemeSettings,
      openDialog,
      closeDialog,
      addToast,
      removeToast,
      triggerBatchDownload
    }}>
      {children}
    </AppStoreContext.Provider>
  );
};

export const useAppStore = () => {
  const context = useContext(AppStoreContext);
  if (context === undefined) {
    throw new Error('useAppStore must be used within an AppStoreProvider');
  }
  return context;
};
