/* src/state/appStore.tsx */
import type { ReactNode } from 'react';
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type {
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
import { tauriClient, getDaemonUrl, getDaemonToken } from '../api/tauriClient';
import { novaClient, setApiBase, setAuthToken } from '../api/novaClient';
import { LANGUAGE_METADATA } from '../lib/i18n/languageMetadata';
import { getTranslation, isLanguageLoaded, loadLanguage, type Language } from '../lib/i18n/translations';
import { createLocalId } from '../utils/idUtils';
import { isDetachedWindow } from '../utils/windowMode';
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
    speedLimit: number | null;
  };
  searchQuery: string;
  dialog: DialogState;
  activePage: AppPage;
  settings: AppSettings;
  themeSettings: AppThemeSettings;
  toasts: ToastItem[];
  isDegradedMode: boolean;
  isNotificationsMuted: boolean;
  setIsNotificationsMuted: (muted: boolean) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  activeProgressMinimizedToTaskbar: boolean;
  setActiveProgressMinimizedToTaskbar: (minimized: boolean) => void;
  minimizedProgressTask: DownloadItem | null;
  setMinimizedProgressTask: (task: DownloadItem | null) => void;
  minimizeActiveProgressToTaskbar: (task?: DownloadItem | null) => void;

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
  reorderQueues: (fromIndex: number, toIndex: number) => void;
  snapshotForUndo: () => void;
  undoLast: () => void;
  updateSettings: (updatedSettings: AppSettings, silent?: boolean) => void;
  updateThemeSettings: (key: keyof AppThemeSettings, value: string) => void;
  openDialog: (active: string, payload?: unknown) => void;
  closeDialog: () => void;
  setActivePage: (page: AppPage) => void;
  addToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string, action?: { label: string; onClick: () => void }) => void;
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

const generateBrowserPairingToken = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `nova_token_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const ensureBrowserPairingToken = (settings: AppSettings): AppSettings => {
  if (settings.extra.browserPairingToken) return settings;
  return {
    ...settings,
    extra: {
      ...settings.extra,
      browserPairingToken: generateBrowserPairingToken(),
    },
  };
};

const supportedLanguages = new Set<string>(LANGUAGE_METADATA.map((language) => language.value));

const normalizeLanguageTag = (value: string) => value.trim().replace(/_/g, '-');

const systemLanguageCandidates = (): string[] => {
  if (typeof navigator === 'undefined') return [];
  const languages = navigator.languages.length ? navigator.languages : [navigator.language];
  return languages.filter((language): language is string => typeof language === 'string' && language.trim().length > 0);
};

const languageFallbacks = (language: string): string[] => {
  const normalized = normalizeLanguageTag(language);
  const lower = normalized.toLowerCase();
  const base = lower.split('-')[0];
  const candidates = [normalized, lower, base];

  if (base === 'zh') {
    if (lower.includes('tw') || lower.includes('hk') || lower.includes('mo') || lower.includes('hant')) {
      candidates.unshift('zh-TW');
    } else {
      candidates.unshift('zh');
    }
  }

  return candidates;
};

const detectSystemLanguage = (): Language => {
  for (const language of systemLanguageCandidates()) {
    for (const candidate of languageFallbacks(language)) {
      if (supportedLanguages.has(candidate)) {
        return candidate as Language;
      }
    }
  }
  return 'en';
};

const mergeStoredSettings = (parsed: Partial<AppSettings>): AppSettings => {
  // Restore all saved folder paths without any restrictive path-name checks.
  const parsedSave = parsed.saveAndCategories;
  const safeSaveAndCategories: Partial<AppSettings['saveAndCategories']> = parsedSave ?? {};
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
      defaults: {
        ...initialSettings.connection.defaults,
        ...(parsed.connection?.defaults || {}),
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
    extra: {
      ...initialSettings.extra,
      ...(parsed.extra || {}),
      language: parsed.extra?.language || detectSystemLanguage(),
    },
  });
};

/**
 * Build the default NOVA download folder path from the OS downloads directory.
 * Structure: <Downloads>/NOVA/
 * Category sub-folders: <Downloads>/NOVA/Video, /Audio, /Documents, etc.
 */
const buildNovaDefaultPaths = (downloadsDir: string): AppSettings['saveAndCategories'] => {
  const sep = downloadsDir.includes('\\') ? '\\' : '/';
  const base = `${downloadsDir.replace(/[\\/]+$/, '')}${sep}NOVA`;
  return {
    defaultFolder: base,
    tempFolder: `${base}${sep}.temp`,
    categoryFolders: {
      document: `${base}${sep}Documents`,
      program: `${base}${sep}Programs`,
      compressed: `${base}${sep}Compressed`,
      video: `${base}${sep}Video`,
      audio: `${base}${sep}Audio`,
      other: `${base}${sep}Other`,
    },
  };
};

const containingFolder = (filePath: string): string => {
  const trimmed = filePath.replace(/[\\/]+$/, '');
  const lastSlash = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return lastSlash > 0 ? trimmed.slice(0, lastSlash) : trimmed;
};

const toMinutes = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

const isQueueScheduledForDay = (queue: Queue, day: number): boolean => {
  if (queue.scheduleType === 'daily') return true;
  return queue.days.includes(day);
};

const isQueueInScheduleWindow = (queue: Queue, now: Date): boolean => {
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
        return ensureBrowserPairingToken({
          ...initialSettings,
          extra: {
            ...initialSettings.extra,
            language: detectSystemLanguage(),
          },
        });
      }
    }
    return ensureBrowserPairingToken({
      ...initialSettings,
      extra: {
        ...initialSettings.extra,
        language: detectSystemLanguage(),
      },
    });
  });
  const [themeSettings, setThemeSettings] = useState<AppThemeSettings>(() => {
    const cached = localStorage.getItem('nova_theme_settings_v1');
    let parsed = {
      theme: 'system',
      density: 'compact',
      accent: 'blue',
      progress: 'bar',
      contrast: 'normal',
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
    speedLimit: null as number | null,
  });
  const [i18nRevision, setI18nRevision] = useState(0);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    isNotificationsMutedRef.current = isNotificationsMuted;
  }, [isNotificationsMuted]);

  // Initialize default download paths from the OS Downloads folder when no path
  // has been configured yet (first run or after a settings reset).
  useEffect(() => {
    if (settings.saveAndCategories.defaultFolder) return;
    let cancelled = false;
    void tauriClient.getDownloadsDir().then((downloadsDir) => {
      if (cancelled || !downloadsDir) return;
      const novaPaths = buildNovaDefaultPaths(downloadsDir);
      setSettings((prev) => {
        // Only fill in blanks — don't clobber user-configured values.
        if (prev.saveAndCategories.defaultFolder) return prev;
        const updated: AppSettings = {
          ...prev,
          saveAndCategories: {
            defaultFolder: novaPaths.defaultFolder,
            tempFolder: prev.saveAndCategories.tempFolder || novaPaths.tempFolder,
            categoryFolders: {
              document: prev.saveAndCategories.categoryFolders.document || novaPaths.categoryFolders.document,
              program: prev.saveAndCategories.categoryFolders.program || novaPaths.categoryFolders.program,
              compressed: prev.saveAndCategories.categoryFolders.compressed || novaPaths.categoryFolders.compressed,
              video: prev.saveAndCategories.categoryFolders.video || novaPaths.categoryFolders.video,
              audio: prev.saveAndCategories.categoryFolders.audio || novaPaths.categoryFolders.audio,
              other: prev.saveAndCategories.categoryFolders.other || novaPaths.categoryFolders.other,
            },
          },
        };
        void tauriClient.saveConfigToDisk(updated);
        return updated;
      });
    });
    return () => {
      cancelled = true;
    };
    // Only run once on mount — we check the value inside the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toasts & Dialog
  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string, action?: { label: string; onClick: () => void }) => {
      if (isNotificationsMutedRef.current) return;
      const currentSettings = settingsRef.current;
      if (currentSettings.sounds.toastSound) {
        playAppSound(currentSettings, type === 'error' ? 'error' : 'notification');
      }
      const id = createLocalId('toast');
      setToasts((prev) => {
        const next = [...prev, { id, type, title, message, action }];
        return next.length > 50 ? next.slice(-50) : next;
      });
      setTimeout(() => {
        removeToast(id);
      }, action ? 6000 : 4500);
    },
    [removeToast],
  );

  const openDialog = useCallback((active: string, payload?: unknown) => {
    // Settings, download lists, and media downloader are full pages, not floating dialogs.
    if (active === 'settings' || active === 'scheduler') {
      setDialog({ active: null });
      setActivePage(active);
      return;
    }
    if (active === 'mediaDownload') {
      // Keep payload (URL) accessible for the page component, but clear any active dialog.
      setDialog({ active: null, payload });
      setActivePage('mediaDownload');
      return;
    }
    if (active === 'activeProgress') {
      setActiveProgressMinimizedToTaskbar(false);
      setMinimizedProgressTask(null);
    }
    setDialog({ active, payload });
  }, []);

  const minimizeActiveProgressToTaskbar = useCallback(
    (task?: DownloadItem | null) => {
      const fallbackTask =
        task ||
        (dialog.active === 'activeProgress' ? (dialog.payload as DownloadItem | null | undefined) || null : null);
      if (!fallbackTask) return;
      setMinimizedProgressTask(fallbackTask);
      setActiveProgressMinimizedToTaskbar(true);
      setDialog({ active: null });
    },
    [dialog.active, dialog.payload],
  );

  const closeDialog = useCallback(() => {
    setActiveProgressMinimizedToTaskbar(false);
    setMinimizedProgressTask(null);
    setDialog({ active: null });
    if (activePage === 'mediaDownload') {
      setActivePage('downloads');
    }
  }, [activePage]);

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
    reorderQueues,
    snapshotForUndo,
    undoLast,
  } = useQueueStore(tasks, addToast, setTasks);

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

  useEffect(() => {
    const activeDownload = tasks.find((task) => task.status === 'downloading');
    if (!activeDownload || activeProgressMinimizedToTaskbar) return;
    let nextProgressTask: DownloadItem | null = null;

    if (dialog.active === 'activeProgress') {
      const activePayload = dialog.payload as { id?: string } | null | undefined;
      const currentTask = activePayload?.id ? tasks.find((task) => task.id === activePayload.id) : null;
      if (!currentTask || currentTask.status !== 'downloading') {
        nextProgressTask = activeDownload;
      }
    } else if (!dialog.active) {
      nextProgressTask = activeDownload;
    }

    if (!nextProgressTask) return;

    const timer = window.setTimeout(() => {
      setDialog((currentDialog) => {
        if (currentDialog.active && currentDialog.active !== 'activeProgress') return currentDialog;
        return { active: 'activeProgress', payload: nextProgressTask };
      });
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeProgressMinimizedToTaskbar, dialog.active, dialog.payload, tasks]);

  // Effects: queue scheduler
  useEffect(() => {
    if (bridge.status !== 'connected' && bridge.status !== 'degraded') return;
    // The scheduler is a singleton owned by the primary window; detached
    // companion windows must not double-drive queue transitions.
    if (isDetachedWindow()) return;

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
    root.setAttribute('data-progress', themeSettings.progress);
    root.setAttribute('data-contrast', themeSettings.contrast);
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
        speedLimit: s.connection.speedLimiter.enabled ? s.connection.speedLimiter.maxSpeedKbs : null,
      });
    };

    const refreshDaemonUrl = async () => {
      const daemonUrl = await getDaemonUrl();
      setApiBase(daemonUrl);
      // The daemon requires a bearer token on non-exempt API routes; fetch it
      // over the trusted Tauri IPC channel and attach it to HTTP calls.
      setAuthToken(await getDaemonToken());
    };

    const connectDaemon = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (cancelled.current) return false;
        try {
          await refreshDaemonUrl();
          const info = await tauriClient.checkDaemonHealth();
          markConnected(info);
          addToast(
            info.status === 'degraded' ? 'warning' : 'success',
            info.status === 'degraded' ? 'Service Partially Ready' : 'Service Connected',
            info.status === 'degraded'
              ? 'NOVA connected to the local service. Some engines are still starting.'
              : 'NOVA connected to the local download service successfully.',
          );
          const params = new URLSearchParams(window.location.search);
          const captureUrl = params.get('capture');
          if (captureUrl) {
            openDialog('addDownload', captureUrl);
            window.history.replaceState({}, '', window.location.pathname);
          }
          return true;
        } catch (e) {
          if (attempt < 39) {
            // Fast initial retries (100ms, 200ms, 400ms…) up to 2s ceiling.
            const delay = Math.min(100 * (1 << attempt), 2000);
            await new Promise((r) => setTimeout(r, delay));
          } else {
            setBridge((b) => ({ ...b, status: 'degraded', version: 'NOVA daemon unavailable' }));
            setIsDegradedMode(true);
            setTasks([]);
            wasDegraded = true;
            addToast(
              'warning',
              'NOVA daemon unavailable',
              e instanceof Error ? e.message : 'The local download engines are not available.',
            );
          }
        }
      }
      return false;
    };
    void connectDaemon().then(() => {
      if (cancelled.current) return;
      const scheduleHealth = () => {
        if (cancelled.current) return;
        retryIntervalRef.current = window.setTimeout(() => {
          if (cancelled.current) return;
          void (async () => {
            try {
              await refreshDaemonUrl();
              const info = await tauriClient.checkDaemonHealth();
              markConnected(info);
              if (wasDegraded) {
                addToast(
                  info.status === 'degraded' ? 'warning' : 'info',
                  'Daemon Reconnected',
                  info.status === 'degraded'
                    ? 'NOVA service is reachable while engines continue starting.'
                    : 'NOVA download service is now available.',
                );
                wasDegraded = false;
              }
            } catch {
              wasDegraded = true;
              setBridge((b) => ({ ...b, status: 'degraded', version: 'Daemon unreachable' }));
              setIsDegradedMode(true);
            }
            scheduleHealth();
          })();
        }, 10000);
      };
      scheduleHealth();
    });

    return () => {
      cancelled.current = true;
      if (retryIntervalRef.current !== null) {
        window.clearTimeout(retryIntervalRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effects: browser extension config
  useEffect(() => {
    if (bridge.status !== 'connected' && bridge.status !== 'degraded') return;
    // Configuration push is owned by the primary window only.
    if (isDetachedWindow()) return;
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
          chatId: parseInt(settings.extra.tgChatId, 10) || 0,
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
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const applyDownloadsImmediate = (daemonTasks: DownloadItem[], fromStream = false) => {
      if (cancelled) return;
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

    // Debounced wrapper: batch rapid SSE events into 100ms chunks to reduce
    // the number of React re-renders during fast downloads.
    let pendingTasks: DownloadItem[] | null = null;
    const applyDownloads = (daemonTasks: DownloadItem[], fromStream = false) => {
      if (!fromStream) {
        applyDownloadsImmediate(daemonTasks, fromStream);
        return;
      }
      pendingTasks = daemonTasks;
      if (debounceTimer === null) {
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          if (pendingTasks !== null) {
            const tasks = pendingTasks;
            pendingTasks = null;
            applyDownloadsImmediate(tasks, true);
          }
        }, 100);
      }
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
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      clearTimeout(initialTimer);
      clearInterval(interval);
      stopEvents?.();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [bridge.status, settings.extra.enableSse]);

  // Settings actions
  const updateSettings = useCallback(
    (updatedSettings: AppSettings, silent = false) => {
      const sanitized = mergeStoredSettings(updatedSettings);
      setSettings(sanitized);
      void tauriClient.saveConfigToDisk(sanitized);
      if (!silent) {
        addToast('success', 'Settings Saved', 'Preferences and settings were saved.');
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
        addToast('error', 'Open File', 'The selected download was not found.');
        return;
      }
      if (task.status !== 'completed') {
        addToast('warning', t('toast_download_not_complete_title'), t('toast_download_not_complete_desc'));
        return;
      }
      if (!task.savePath) {
        addToast('error', t('toast_file_opened_title'), 'No saved file path is available for this download.');
        return;
      }

      const opened = await tauriClient.openDownloadedFile(task.savePath);
      if (opened) {
        addToast('success', t('toast_file_opened_title'), t('toast_file_opened_desc', { name: task.name }));
      } else {
        addToast('error', t('toast_file_opened_title'), `Could not open "${task.name}". The file may have moved.`);
      }
    },
    [addToast, t, tasks],
  );

  const openTaskLocation = useCallback(
    async (id: string) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) {
        addToast('error', 'Open File Location', 'The selected download was not found.');
        return;
      }
      if (!task.savePath) {
        addToast('error', t('toast_folder_opened_title'), 'No saved file path is available for this download.');
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
        addToast('error', t('toast_folder_opened_title'), `Could not open the location for "${task.name}".`);
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
      isDegradedMode,
      isNotificationsMuted,
      setIsNotificationsMuted,
      t,
      activeProgressMinimizedToTaskbar,
      setActiveProgressMinimizedToTaskbar,
      minimizedProgressTask,
      setMinimizedProgressTask,
      minimizeActiveProgressToTaskbar,
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
      reorderQueues,
      snapshotForUndo,
      undoLast,
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
      isDegradedMode,
      isNotificationsMuted,
      t,
      activeProgressMinimizedToTaskbar,
      minimizedProgressTask,
      minimizeActiveProgressToTaskbar,
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
      reorderQueues,
      snapshotForUndo,
      undoLast,
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
