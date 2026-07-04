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
   initialSettings
} from '../initialData';
import { tauriClient, getDaemonUrl } from '../api/tauriClient';
import { novaClient, setApiBase } from '../api/novaClient';
import { getTranslation, isLanguageLoaded, loadLanguage } from '../lib/i18n/translations';
import { useQueueStore } from './useQueueStore';
import { useTaskStore, mergeDaemonTasks } from './useTaskStore';

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
  openDialog: (active: string, payload?: unknown) => void;
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
  const [settings, setSettings] = useState<AppSettings>(() => {
    const cached = localStorage.getItem('nova_settings_v1');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return ensureBrowserPairingToken({
          ...initialSettings,
          ...parsed,
          general: { ...initialSettings.general, ...(parsed.general || {}) },
          connection: { ...initialSettings.connection, ...(parsed.connection || {}) },
          saveAndCategories: {
            ...initialSettings.saveAndCategories,
            ...(parsed.saveAndCategories && parsed.saveAndCategories.defaultFolder && parsed.saveAndCategories.defaultFolder.includes('NOVA') ? parsed.saveAndCategories : {})
          },
          sounds: { ...initialSettings.sounds, ...(parsed.sounds || {}) },
          advanced: { ...initialSettings.advanced, ...(parsed.advanced || {}) },
          extra: { ...initialSettings.extra, ...(parsed.extra || {}) }
        });
      } catch {
        return ensureBrowserPairingToken(initialSettings);
      }
    }
    return ensureBrowserPairingToken(initialSettings);
  });
  const [themeSettings, setThemeSettings] = useState<AppThemeSettings>(() => {
    const cached = localStorage.getItem('nova_theme_settings_v1');
    let parsed = {
      theme: 'dark', density: 'compact', accent: 'blue',
      sidebar: 'expanded', progress: 'bar', contrast: 'normal',
      motion: 'enabled', blur: 'enabled'
    };
    if (cached) {
      try { parsed = { ...parsed, ...JSON.parse(cached) }; } catch { /* corrupt cache — keep defaults */ }
    }
    parsed.theme = 'dark';
    return parsed;
  });

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<'all' | 'unfinished' | 'finished' | 'queued' | FileType | 'browser' | 'scheduler' | 'diagnostics'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dialog, setDialog] = useState<DialogState>({ active: null });
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [isLoading] = useState(false);
  const [isDegradedMode, setIsDegradedMode] = useState(false);
  const [isNotificationsMuted, setIsNotificationsMuted] = useState<boolean>(() => {
    const cached = localStorage.getItem('nova_notifications_muted');
    return cached === 'true';
  });
  const [activeProgressMinimizedToTaskbar, setActiveProgressMinimizedToTaskbar] = useState<boolean>(false);
  const [minimizedProgressTask, setMinimizedProgressTask] = useState<DownloadItem | null>(null);
  const [bridge, setBridge] = useState({
    status: 'connecting' as 'connected' | 'connecting' | 'disconnected' | 'degraded',
    version: '', pid: 0, uptime: 0, speedLimit: null as number | null
  });
  const [i18nRevision, setI18nRevision] = useState(0);

  // Toasts & Dialog
  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const addToast = (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string) => {
    if (isNotificationsMuted) return;
    const id = createLocalId('toast');
    setToasts(prev => [...prev, { id, type, title, message }]);
    setTimeout(() => removeToast(id), 4500);
  };

  const openDialog = (active: string, payload?: unknown) => {
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

  // Queue store
  const {
    queues,
    setQueues,
    updateQueue,
    addQueue,
    deleteQueue,
    removeTaskFromQueue,
    moveTaskToQueue,
    createQueueAndMoveTask
  } = useQueueStore(tasks, addToast, setTasks);

  // Task store
  const {
    addTask,
    pauseTask,
    resumeTask,
    deleteTask,
    updateTaskProperties,
    triggerBatchDownload
  } = useTaskStore(tasks, setTasks, selectedTaskId, setSelectedTaskId, bridge.status, addToast, openDialog, setQueues, setIsDegradedMode, settings);

  // Effects: i18n
  useEffect(() => {
    const lang = settings.extra.language || 'en';
    if (isLanguageLoaded(lang)) return;
    let cancelled = false;
    void loadLanguage(lang).then(() => {
      if (!cancelled) setI18nRevision(revision => revision + 1);
    });
    return () => { cancelled = true; };
  }, [settings.extra.language]);

  // Effects: theme
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
    root.setAttribute('lang', settings?.extra?.language || 'en');
    if (themeSettings.theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => updateTheme();
      mediaQuery.addEventListener('change', listener);
      return () => mediaQuery.removeEventListener('change', listener);
    }
  }, [themeSettings, settings?.extra?.language]);

  // Effects: localStorage persistence
  useEffect(() => { localStorage.setItem('nova_settings_v1', JSON.stringify(settings)); }, [settings]);
  useEffect(() => { localStorage.setItem('nova_theme_settings_v1', JSON.stringify(themeSettings)); }, [themeSettings]);
  useEffect(() => { localStorage.setItem('nova_notifications_muted', String(isNotificationsMuted)); }, [isNotificationsMuted]);

  // Effects: daemon connection + perpetual reconnection
  useEffect(() => {
    let cancelled = false;
    const retryIntervalRef: { current: number | null } = { current: null };

    const markConnected = (info: { buildVersion?: string; version: string; pid: number }) => {
      setIsDegradedMode(false);
      setBridge({
        status: 'connected',
        version: info.buildVersion || info.version,
        pid: info.pid, uptime: 1,
        speedLimit: settings.connection.speedLimiter.enabled ? settings.connection.speedLimiter.maxSpeedKbs : null
      });
    };

    const connectDaemon = async (): Promise<boolean> => {
      const daemonUrl = await getDaemonUrl();
      setApiBase(daemonUrl);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (cancelled) return false;
        try {
          const info = await tauriClient.checkDaemonHealth();
          if (cancelled) return false;
          markConnected(info);
          addToast('success', 'Service Connected', 'NOVA connected to the local download service successfully.');
          const params = new URLSearchParams(window.location.search);
          const captureUrl = params.get('capture');
          if (captureUrl) {
            openDialog('addDownload', captureUrl);
            window.history.replaceState({}, '', window.location.pathname);
          }
          return true;
        } catch (e) {
          if (cancelled) return false;
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
      return false;
    };

    let restartAttempted = false;
    void connectDaemon().then((connected) => {
      if (cancelled || connected) return;
      // Perpetual background reconnection: poll every 5 s until the daemon
      // becomes reachable, then transition to 'connected'.
      retryIntervalRef.current = window.setInterval(async () => {
        if (cancelled) { window.clearInterval(retryIntervalRef.current!); return; }
        try {
          const info = await tauriClient.checkDaemonHealth();
          if (cancelled) return;
          markConnected(info);
          addToast('info', 'Daemon Reconnected', 'NOVA download service is now available.');
          window.clearInterval(retryIntervalRef.current!);
        } catch {
          // daemon still unreachable – keep polling
        }
      }, 5000);
    });

    return () => {
      cancelled = true;
      if (retryIntervalRef.current !== null) {
        window.clearInterval(retryIntervalRef.current);
      }
    };
    // Run once on mount – the perpetual interval handles reconnection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effects: daemon uptime tick
  useEffect(() => {
    if (bridge.status !== 'connected') return;
    const connectedAt = Date.now();
    const interval = setInterval(() => {
      if (document.hidden) return;
      setBridge(b => ({ ...b, uptime: Math.round((Date.now() - connectedAt) / 1000) }));
    }, 1000);
    return () => clearInterval(interval);
  }, [bridge.status]);

  // Effects: browser extension config
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
    }).catch(() => {});
  }, [bridge.status, settings.general.integrateWithBrowsers, settings.extra.browserPairingToken,
      settings.fileTypes.autoDownloadMaxSizeMb, settings.saveAndCategories.defaultFolder,
      settings.saveAndCategories.categoryFolders, settings.extra.userAgent]);

  // Effects: task polling
  useEffect(() => {
    if (bridge.status !== 'connected') return;
    let cancelled = false;
    const syncDownloads = async () => {
      try {
        const daemonTasks = await novaClient.listDownloads();
        if (cancelled) return;
        setTasks(mergeDaemonTasks(daemonTasks));
        setIsDegradedMode(false);
      } catch {
        if (!cancelled) {
          setBridge(b => ({ ...b, status: 'degraded' }));
          setIsDegradedMode(true);
        }
      }
    };
    syncDownloads();
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

  // Settings actions
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

  // Translation
  const t = (key: string, params?: Record<string, string | number>) => {
    void i18nRevision;
    return getTranslation(settings.extra.language || 'en', key, params);
  };

  return (
    <AppStoreContext.Provider value={{
      tasks, queues, selectedTaskId, workspaceView, bridge, searchQuery, dialog,
      settings, themeSettings, toasts, isLoading, isDegradedMode,
      isNotificationsMuted, setIsNotificationsMuted,
      updatingTaskId, setUpdatingTaskId, t,
      activeProgressMinimizedToTaskbar, setActiveProgressMinimizedToTaskbar,
      minimizedProgressTask, setMinimizedProgressTask,
      setWorkspaceView, setSearchQuery, setSelectedTaskId,
      addTask, pauseTask, resumeTask, deleteTask, updateTaskProperties,
      updateQueue, addQueue, deleteQueue, removeTaskFromQueue,
      moveTaskToQueue, createQueueAndMoveTask,
      updateSettings, updateThemeSettings,
      openDialog, closeDialog, addToast, removeToast, triggerBatchDownload
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
