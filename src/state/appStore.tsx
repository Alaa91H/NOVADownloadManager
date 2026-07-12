/* src/state/appStore.tsx */
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react';
import {
  DownloadItem,
  Queue,
  AppSettings,
  AppThemeSettings,
  AppPage,
  ToastItem,
  DialogState,
  FileType,
} from '../types/desktop-ui.types';
import { initialSettings } from '../initialData';
import { tauriClient, getDaemonUrl } from '../api/tauriClient';
import { novaClient, setApiBase } from '../api/novaClient';
import { getTranslation, isLanguageLoaded, loadLanguage } from '../lib/i18n/translations';
import { createLocalId } from '../utils/idUtils';
import { playAppSound } from '../utils/sound';
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
  activePage: AppPage;
  settings: AppSettings;
  themeSettings: AppThemeSettings;
  toasts: ToastItem[];
  isLoading: boolean;
  isDegradedMode: boolean;
  isNotificationsMuted: boolean;
  setIsNotificationsMuted: (muted: boolean) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  activeProgressMinimizedToTaskbar: boolean;
  setActiveProgressMinimizedToTaskbar: (minimized: boolean) => void;
  minimizedProgressTask: DownloadItem | null;
  setMinimizedProgressTask: (task: DownloadItem | null) => void;

  // Actions
  setWorkspaceView: (
    view: 'all' | 'unfinished' | 'finished' | 'queued' | FileType | 'browser' | 'scheduler' | 'diagnostics',
  ) => void;
  setSearchQuery: (query: string) => void;
  setSelectedTaskId: (id: string | null) => void;
  addTask: (
    task: Omit<
      DownloadItem,
      'id' | 'dateAdded' | 'downloadedBytes' | 'speedBytesPerSec' | 'timeLeftSeconds' | 'segments'
    >,
    downloadImmediately: boolean,
  ) => Promise<DownloadItem | null>;
  pauseTask: (id: string) => void;
  resumeTask: (id: string) => void;
  deleteTask: (id: string, deleteDisk: boolean) => Promise<void>;
  openTaskFile: (id: string) => Promise<void>;
  openTaskLocation: (id: string) => Promise<void>;
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
  setActivePage: (page: AppPage) => void;
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
    },
  ) => Promise<void>;
}

const AppStoreContext = createContext<AppStoreContextType | undefined>(undefined);

export const generateBrowserPairingToken = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `nova_token_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const ensureBrowserPairingToken = (settings: AppSettings): AppSettings => {
  if (settings.extra.browserPairingToken) return settings;
  return {
    ...settings,
    extra: {
      ...settings.extra,
      browserPairingToken: generateBrowserPairingToken(),
    },
  };
};

export const mergeStoredSettings = (parsed: Partial<AppSettings>): AppSettings => {
  const parsedSave = parsed.saveAndCategories;
  const safeSaveAndCategories: Partial<AppSettings['saveAndCategories']> =
    parsedSave && parsedSave.defaultFolder && parsedSave.defaultFolder.includes('NOVA') ? parsedSave : {};
  const parsedUi = parsed.ui;
  const parsedShortcuts = parsed.keyboardShortcuts;

  return ensureBrowserPairingToken({
    ...initialSettings,
    ...parsed,
    general: {
      ...initialSettings.general,
      ...(parsed.general || {}),
      integrateWithBrowsers: {
        ...initialSettings.general.integrateWithBrowsers,
        ...(parsed.general?.integrateWithBrowsers || {}),
      },
    },
    connection: {
      ...initialSettings.connection,
      ...(parsed.connection || {}),
      speedLimiter: {
        ...initialSettings.connection.speedLimiter,
        ...(parsed.connection?.speedLimiter || {}),
      },
    },
    saveAndCategories: {
      ...initialSettings.saveAndCategories,
      ...safeSaveAndCategories,
      categoryFolders: {
        ...initialSettings.saveAndCategories.categoryFolders,
        ...(safeSaveAndCategories.categoryFolders || {}),
      },
    },
    sounds: { ...initialSettings.sounds, ...(parsed.sounds || {}) },
    ui: {
      ...initialSettings.ui,
      ...(parsedUi || {}),
      toolbar: {
        ...initialSettings.ui.toolbar,
        ...(parsedUi?.toolbar || {}),
      },
      statusBar: {
        ...initialSettings.ui.statusBar,
        ...(parsedUi?.statusBar || {}),
      },
      customButtons: parsedUi?.customButtons || initialSettings.ui.customButtons,
    },
    keyboardShortcuts: {
      ...initialSettings.keyboardShortcuts,
      ...(parsedShortcuts || {}),
      bindings: {
        ...initialSettings.keyboardShortcuts.bindings,
        ...(parsedShortcuts?.bindings || {}),
      },
    },
    advanced: { ...initialSettings.advanced, ...(parsed.advanced || {}) },
    extra: { ...initialSettings.extra, ...(parsed.extra || {}) },
  });
};

export const containingFolder = (filePath: string): string => {
  const trimmed = filePath.replace(/[\\/]+$/, '');
  const lastSlash = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return lastSlash > 0 ? trimmed.slice(0, lastSlash) : trimmed;
};

export const toMinutes = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

export const isQueueScheduledForDay = (queue: Queue, day: number): boolean => {
  if (queue.scheduleType === 'daily') return true;
  return queue.days.includes(day);
};

export const isQueueInScheduleWindow = (queue: Queue, now: Date): boolean => {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  const start = toMinutes(queue.startTime);
  const end = toMinutes(queue.endTime);
  if (start == null || end == null) return false;
  if (start === end) return isQueueScheduledForDay(queue, today);
  if (start < end) {
    return isQueueScheduledForDay(queue, today) && nowMinutes >= start && nowMinutes < end;
  }
  if (nowMinutes >= start) return isQueueScheduledForDay(queue, today);
  return isQueueScheduledForDay(queue, yesterday) && nowMinutes < end;
};

export const AppStoreProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [tasks, setTasks] = useState<DownloadItem[]>([]);
  const [settings, setSettings] = useState<AppSettings>(() => {
    const cached = localStorage.getItem('nova_settings_v1');
    if (cached) {
      try {
        const parsed: Partial<AppSettings> = JSON.parse(cached) as Partial<AppSettings>;
        return mergeStoredSettings(parsed);
      } catch {
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
      blur: 'enabled',
    };
    if (cached) {
      try {
        parsed = { ...parsed, ...(JSON.parse(cached) as AppThemeSettings) };
      } catch {
        /* corrupt cache — keep defaults */
      }
    }
    return parsed as AppThemeSettings;
  });

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<
    'all' | 'unfinished' | 'finished' | 'queued' | FileType | 'browser' | 'scheduler' | 'diagnostics'
  >('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dialog, setDialog] = useState<DialogState>({ active: null });
  const [activePage, setActivePage] = useState<AppPage>('downloads');
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const settingsRef = useRef(settings);
  const completedTaskIdsRef = useRef<Set<string>>(new Set());
  const hasSyncedDownloadsRef = useRef(false);
  const activeScheduleWindowsRef = useRef<Record<string, boolean>>({});
  const [isDegradedMode, setIsDegradedMode] = useState(false);
  const [isNotificationsMuted, setIsNotificationsMuted] = useState<boolean>(() => {
    const cached = localStorage.getItem('nova_notifications_muted');
    return cached === 'true';
  });
  const isNotificationsMutedRef = useRef(isNotificationsMuted);
  const [activeProgressMinimizedToTaskbar, setActiveProgressMinimizedToTaskbar] = useState<boolean>(false);
  const [minimizedProgressTask, setMinimizedProgressTask] = useState<DownloadItem | null>(null);
  const [bridge, setBridge] = useState({
    status: 'connecting' as 'connected' | 'connecting' | 'disconnected' | 'degraded',
    version: '',
    pid: 0,
    uptime: 0,
    speedLimit: null as number | null,
  });
  const [i18nRevision, setI18nRevision] = useState(0);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    isNotificationsMutedRef.current = isNotificationsMuted;
  }, [isNotificationsMuted]);

  // Toasts & Dialog
  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string) => {
      if (isNotificationsMutedRef.current) return;
      const currentSettings = settingsRef.current;
      if (currentSettings.sounds.toastSound) {
        playAppSound(currentSettings, type === 'error' ? 'error' : 'notification');
      }
      const id = createLocalId('toast');
      setToasts((prev) => {
        const next = [...prev, { id, type, title, message }];
        return next.length > 50 ? next.slice(-50) : next;
      });
      setTimeout(() => {
        removeToast(id);
      }, 4500);
    },
    [removeToast],
  );

  const openDialog = useCallback((active: string, payload?: unknown) => {
    // Settings and download lists are full pages, not floating dialogs.
    if (active === 'settings' || active === 'scheduler') {
      setDialog({ active: null });
      setActivePage(active);
      return;
    }
    if (active === 'activeProgress') {
      setActiveProgressMinimizedToTaskbar(false);
      setMinimizedProgressTask(null);
    }
    setDialog({ active, payload });
  }, []);

  const closeDialog = useCallback(() => {
    setActiveProgressMinimizedToTaskbar(false);
    setMinimizedProgressTask(null);
    setDialog({ active: null });
  }, []);

  // Queue store
  const {
    queues,
    updateQueue,
    addQueue,
    deleteQueue,
    removeTaskFromQueue,
    moveTaskToQueue,
    addTaskToQueueOrder,
    createQueueAndMoveTask,
  } = useQueueStore(tasks, addToast, setTasks, settings.extra.language);

  // Task store
  const { addTask, pauseTask, resumeTask, deleteTask, updateTaskProperties, triggerBatchDownload } = useTaskStore(
    tasks,
    setTasks,
    selectedTaskId,
    setSelectedTaskId,
    bridge.status,
    addToast,
    openDialog,
    addTaskToQueueOrder,
    setIsDegradedMode,
    settings,
  );

  // Effects: queue scheduler
  useEffect(() => {
    if (bridge.status !== 'connected' && bridge.status !== 'degraded') return;

    const tickSchedules = () => {
      const now = new Date();

      queues.forEach((queue) => {
        const wasActive = activeScheduleWindowsRef.current[queue.id] || false;
        const isActive = queue.scheduled && !queue.scheduleCompleted && isQueueInScheduleWindow(queue, now);

        if (isActive && !wasActive) {
          activeScheduleWindowsRef.current[queue.id] = true;
          tasks
            .filter(
              (task) =>
                task.queueId === queue.id &&
                (task.status === 'queued' || task.status === 'paused' || task.status === 'error'),
            )
            .slice(0, Math.max(1, queue.maxActive || 1))
            .forEach((task) => {
              void resumeTask(task.id);
            });
        }

        if (!isActive && wasActive) {
          activeScheduleWindowsRef.current[queue.id] = false;
          tasks
            .filter((task) => task.queueId === queue.id && task.status === 'downloading')
            .forEach((task) => {
              void pauseTask(task.id);
            });

          if (queue.scheduleType === 'once') {
            updateQueue(queue.id, { scheduled: false, scheduleCompleted: true }, true);
          }
        }

        if (!queue.scheduled) {
          activeScheduleWindowsRef.current[queue.id] = false;
        }
      });
    };

    tickSchedules();
    const interval = window.setInterval(tickSchedules, 30000);
    return () => {
      window.clearInterval(interval);
    };
  }, [bridge.status, pauseTask, queues, resumeTask, tasks, updateQueue]);

  // Effects: i18n
  useEffect(() => {
    const lang = settings.extra.language || 'en';
    if (isLanguageLoaded(lang)) return;
    let cancelled = false;
    void loadLanguage(lang).then(() => {
      if (!cancelled) setI18nRevision((revision) => revision + 1);
    });
    return () => {
      cancelled = true;
    };
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
    root.setAttribute('lang', settings.extra.language || 'en');
    if (themeSettings.theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => {
        updateTheme();
      };
      mediaQuery.addEventListener('change', listener);
      return () => {
        mediaQuery.removeEventListener('change', listener);
      };
    }
  }, [themeSettings, settings.extra.language]);

  // Effects: localStorage persistence
  useEffect(() => {
    localStorage.setItem('nova_settings_v1', JSON.stringify(settings));
    localStorage.setItem('nova_theme_settings_v1', JSON.stringify(themeSettings));
    localStorage.setItem('nova_notifications_muted', String(isNotificationsMuted));
  }, [settings, themeSettings, isNotificationsMuted]);

  // Effects: daemon connection + perpetual reconnection
  useEffect(() => {
    const cancelled: { current: boolean } = { current: false };
    const retryIntervalRef: { current: number | null } = { current: null };
    let wasDegraded = false;

    const markConnected = (info: {
      status?: 'connected' | 'degraded';
      buildVersion?: string;
      version: string;
      pid: number;
    }) => {
      const status = info.status || 'connected';
      setIsDegradedMode(status === 'degraded');
      const s = settingsRef.current;
      setBridge({
        status,
        version: info.buildVersion || info.version,
        pid: info.pid,
        uptime: 1,
        speedLimit: s.connection.speedLimiter.enabled ? s.connection.speedLimiter.maxSpeedKbs : null,
      });
    };

    const ensureStartupDelay = () => new Promise<void>((r) => setTimeout(r, 2000));

    const refreshDaemonUrl = async () => {
      const daemonUrl = await getDaemonUrl();
      setApiBase(daemonUrl);
    };

    const connectDaemon = async (): Promise<boolean> => {
      await ensureStartupDelay();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (cancelled.current) return false;
        try {
          await refreshDaemonUrl();
          const info = await tauriClient.checkDaemonHealth();
          markConnected(info);
          const lang = settingsRef.current.extra.language || 'en';
          addToast(
            info.status === 'degraded' ? 'warning' : 'success',
            info.status === 'degraded' ? getTranslation(lang, 'toast_service_partial_title') : getTranslation(lang, 'toast_service_connected_title'),
            info.status === 'degraded'
              ? getTranslation(lang, 'toast_service_partial_desc')
              : getTranslation(lang, 'toast_service_connected_desc'),
          );
          const params = new URLSearchParams(window.location.search);
          const captureUrl = params.get('capture');
          if (captureUrl) {
            openDialog('addDownload', captureUrl);
            window.history.replaceState({}, '', window.location.pathname);
          }
          return true;
        } catch (e) {
          if (attempt < 29) {
            const delay = Math.min(500 * (1 << attempt), 3000);
            await new Promise((r) => setTimeout(r, delay));
          } else {
            const lang = settingsRef.current.extra.language || 'en';
            setIsLoading(false);
            setBridge((b) => ({ ...b, status: 'degraded', version: getTranslation(lang, 'toast_daemon_unavailable_title') }));
            setIsDegradedMode(true);
            setTasks([]);
            wasDegraded = true;
            addToast(
              'warning',
              getTranslation(lang, 'toast_daemon_unavailable_title'),
              e instanceof Error ? e.message : getTranslation(lang, 'toast_daemon_unavailable_desc'),
            );
          }
        }
      }
      return false;
    };
    void connectDaemon().then(() => {
      if (cancelled.current) return;
      retryIntervalRef.current = window.setInterval(() => {
        void (async () => {
          if (cancelled.current) {
            if (retryIntervalRef.current !== null) window.clearInterval(retryIntervalRef.current);
            return;
          }
          try {
            await refreshDaemonUrl();
            const info = await tauriClient.checkDaemonHealth();
            markConnected(info);
            if (wasDegraded) {
              const lang = settingsRef.current.extra.language || 'en';
              addToast(
                info.status === 'degraded' ? 'warning' : 'info',
                getTranslation(lang, 'toast_daemon_reconnected_title'),
                info.status === 'degraded'
                  ? getTranslation(lang, 'toast_daemon_reconnected_partial_desc')
                  : getTranslation(lang, 'toast_daemon_reconnected_desc'),
              );
              wasDegraded = false;
            }
          } catch {
            wasDegraded = true;
            setBridge((b) => ({ ...b, status: 'degraded', version: getTranslation(settingsRef.current.extra.language || 'en', 'toast_daemon_unavailable_title') }));
            setIsDegradedMode(true);
          }
        })();
      }, 5000);
    });

    return () => {
      cancelled.current = true;
      if (retryIntervalRef.current !== null) {
        window.clearInterval(retryIntervalRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effects: daemon uptime tick
  useEffect(() => {
    if (bridge.status !== 'connected' && bridge.status !== 'degraded') return;
    const connectedAt = Date.now();
    const interval = setInterval(() => {
      if (document.hidden) return;
      setBridge((b) => ({ ...b, uptime: Math.round((Date.now() - connectedAt) / 1000) }));
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [bridge.status]);

  // Effects: browser extension config
  useEffect(() => {
    if (bridge.status !== 'connected' && bridge.status !== 'degraded') return;
    const enabled = Object.values(settings.general.integrateWithBrowsers).some(Boolean);
    void novaClient
      .configureBrowserExtension({
        enabled,
        token: settings.extra.browserPairingToken,
        minSizeMb: settings.fileTypes.autoDownloadMaxSizeMb,
        defaultFolder: settings.saveAndCategories.defaultFolder,
        categoryFolders: settings.saveAndCategories.categoryFolders,
        userAgent: settings.extra.userAgent,
      })
      .catch((e: unknown) => {
        console.warn('configureBrowserExtension failed', e);
      });
  }, [
    bridge.status,
    settings.general.integrateWithBrowsers,
    settings.extra.browserPairingToken,
    settings.fileTypes.autoDownloadMaxSizeMb,
    settings.saveAndCategories.defaultFolder,
    settings.saveAndCategories.categoryFolders,
    settings.extra.userAgent,
  ]);

  // Effects: Telegram bot config
  useEffect(() => {
    if (bridge.status !== 'connected' && bridge.status !== 'degraded') return;
    const timer = window.setTimeout(() => {
      void novaClient
        .updateTelegramConfig({
          enabled: settings.extra.tgEnabled,
          token: settings.extra.tgBotToken,
          chatId: parseInt(settings.extra.tgChatId) || 0,
          apiBase: settings.extra.tgApiBase,
          fileUploadLimitMb: settings.extra.tgFileUploadLimitMb,
        })
        .catch((e: unknown) => {
          console.warn('updateTelegramConfig failed', e);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    bridge.status,
    settings.extra.tgEnabled,
    settings.extra.tgBotToken,
    settings.extra.tgChatId,
    settings.extra.tgApiBase,
    settings.extra.tgFileUploadLimitMb,
  ]);

  // Effects: live task sync with polling fallback.
  useEffect(() => {
    if (bridge.status !== 'connected' && bridge.status !== 'degraded') return;
    let cancelled = false;
    let started = false;
    let sseFailed = false;
    let fallbackTick = 0;
    let stopEvents: (() => void) | null = null;

    const applyDownloads = (daemonTasks: DownloadItem[], fromStream = false) => {
      if (cancelled) return;
      if (!started && !fromStream) {
        setIsLoading(false);
      }
      started = true;
      if (fromStream) {
        sseFailed = false;
      }
      const completedIds = new Set(daemonTasks.filter((task) => task.status === 'completed').map((task) => task.id));
      const newlyCompletedTasks = daemonTasks.filter(
        (task) => task.status === 'completed' && !completedTaskIdsRef.current.has(task.id),
      );
      const shouldRunCompletionActions = hasSyncedDownloadsRef.current;
      completedTaskIdsRef.current = completedIds;
      hasSyncedDownloadsRef.current = true;

      if (shouldRunCompletionActions) {
        const currentSettings = settingsRef.current;
        newlyCompletedTasks.forEach((task) => {
          if (currentSettings.sounds.enabled) {
            playAppSound(currentSettings, 'complete');
            void tauriClient.triggerNativeNotification('Download complete', `"${task.name}" finished downloading.`);
          }
          if (!task.savePath) return;
          if (currentSettings.extra.virusScan) {
            void tauriClient.scanDownloadedFile(task.savePath);
          }
          if (currentSettings.extra.openOnComplete) {
            void tauriClient.openDownloadedFile(task.savePath);
          }
          if (currentSettings.extra.openFolderOnComplete) {
            void tauriClient.revealDownloadedFile(task.savePath);
          }
        });
        if (
          currentSettings.sounds.enabled &&
          newlyCompletedTasks.length > 0 &&
          !daemonTasks.some((task) => task.status === 'downloading' || task.status === 'queued')
        ) {
          playAppSound(currentSettings, 'queueFinished');
        }
      }

      setTasks(mergeDaemonTasks(daemonTasks));
      setIsDegradedMode(bridge.status === 'degraded');
    };

    const syncDownloads = async () => {
      try {
        const daemonTasks = await novaClient.listDownloads();
        applyDownloads(daemonTasks);
      } catch {
        if (!cancelled && started) {
          setIsDegradedMode(true);
        }
      }
    };

    const canStreamDownloads = settings.extra.enableSse && typeof window.EventSource !== 'undefined';
    if (canStreamDownloads) {
      stopEvents = novaClient.streamDownloads(
        (daemonTasks) => {
          applyDownloads(daemonTasks, true);
        },
        () => {
          sseFailed = true;
        },
      );
    }

    const initialTimer = setTimeout(() => {
      if (cancelled) return;
      started = true;
      void syncDownloads();
    }, 1000);
    const interval = setInterval(() => {
      if (document.hidden) return;
      fallbackTick += 1;
      if (canStreamDownloads && !sseFailed && fallbackTick % 5 !== 0) return;
      void syncDownloads();
    }, 2000);
    const onVisibilityChange = () => {
      if (!document.hidden) void syncDownloads();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
      stopEvents?.();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [bridge.status, settings.extra.enableSse]);

  // Settings actions
  const updateSettings = useCallback(
    (updatedSettings: AppSettings, silent = false) => {
      setSettings(updatedSettings);
      void tauriClient.saveConfigToDisk(updatedSettings);
      if (!silent) {
        addToast('success', t('toast_settings_saved_title'), t('toast_settings_saved_desc'));
      }
    },
    [addToast],
  );

  const updateThemeSettings = useCallback((key: keyof AppThemeSettings, value: string) => {
    setThemeSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Translation
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => {
      void i18nRevision;
      return getTranslation(settings.extra.language || 'en', key, params);
    },
    [settings.extra.language, i18nRevision],
  );

  // Effects: unsigned update check. This intentionally does not download or
  // install updates automatically, so development builds do not require signing.
  useEffect(() => {
    if (!settings.general.checkUpdates) return;
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem('nova_last_unsigned_update_check') === today) return;
    localStorage.setItem('nova_last_unsigned_update_check', today);
    void tauriClient
      .checkUnsignedUpdate()
      .then((result) => {
        if (result.hasUpdate) {
          addToast(
            'info',
            t('settings_update_available'),
            t('settings_update_available_msg', { version: result.latestVersion }),
          );
        }
      })
      .catch((error: unknown) => {
        console.warn('unsigned update check failed', error);
      });
  }, [addToast, settings.general.checkUpdates, t]);

  const openTaskFile = useCallback(
    async (id: string) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) {
        addToast('error', t('toast_file_opened_title'), t('toast_open_file_not_found'));
        return;
      }
      if (task.status !== 'completed') {
        addToast('warning', t('toast_download_not_complete_title'), t('toast_download_not_complete_desc'));
        return;
      }
      if (!task.savePath) {
        addToast('error', t('toast_file_opened_title'), t('toast_no_save_path'));
        return;
      }

      const opened = await tauriClient.openDownloadedFile(task.savePath);
      if (opened) {
        addToast('success', t('toast_file_opened_title'), t('toast_file_opened_desc', { name: task.name }));
      } else {
        addToast('error', t('toast_file_opened_title'), t('toast_open_file_failed', { name: task.name }));
      }
    },
    [addToast, t, tasks],
  );

  const openTaskLocation = useCallback(
    async (id: string) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) {
        addToast('error', t('toast_folder_opened_title'), t('toast_open_location_not_found'));
        return;
      }
      if (!task.savePath) {
        addToast('error', t('toast_folder_opened_title'), t('toast_no_save_path'));
        return;
      }

      const opened = await tauriClient.revealDownloadedFile(task.savePath);
      if (opened) {
        addToast(
          'success',
          t('toast_folder_opened_title'),
          t('toast_folder_opened_desc', { folder: containingFolder(task.savePath), name: task.name }),
        );
      } else {
        addToast('error', t('toast_folder_opened_title'), t('toast_open_location_failed', { name: task.name }));
      }
    },
    [addToast, t, tasks],
  );

  const providerValue = useMemo(
    () => ({
      tasks,
      queues,
      selectedTaskId,
      workspaceView,
      bridge,
      searchQuery,
      dialog,
      activePage,
      settings,
      themeSettings,
      toasts,
      isLoading,
      isDegradedMode,
      isNotificationsMuted,
      setIsNotificationsMuted,
      t,
      activeProgressMinimizedToTaskbar,
      setActiveProgressMinimizedToTaskbar,
      minimizedProgressTask,
      setMinimizedProgressTask,
      setActivePage,
      setWorkspaceView,
      setSearchQuery,
      setSelectedTaskId,
      addTask,
      pauseTask,
      resumeTask,
      deleteTask,
      openTaskFile,
      openTaskLocation,
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
      triggerBatchDownload,
    }),
    [
      tasks,
      queues,
      selectedTaskId,
      workspaceView,
      bridge,
      searchQuery,
      dialog,
      activePage,
      settings,
      themeSettings,
      toasts,
      isLoading,
      isDegradedMode,
      isNotificationsMuted,
      t,
      activeProgressMinimizedToTaskbar,
      minimizedProgressTask,
      setIsNotificationsMuted,
      setActiveProgressMinimizedToTaskbar,
      setMinimizedProgressTask,
      setWorkspaceView,
      setSearchQuery,
      setSelectedTaskId,
      addTask,
      pauseTask,
      resumeTask,
      deleteTask,
      openTaskFile,
      openTaskLocation,
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
      triggerBatchDownload,
    ],
  );

  return <AppStoreContext.Provider value={providerValue}>{children}</AppStoreContext.Provider>;
};

export const useAppStore = () => {
  const context = useContext(AppStoreContext);
  if (context === undefined) {
    throw new Error('useAppStore must be used within an AppStoreProvider');
  }
  return context;
};
