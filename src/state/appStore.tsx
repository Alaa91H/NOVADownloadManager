/* src/state/appStore.tsx */
import type { ReactNode } from 'react';
import React, { useEffect, useRef } from 'react';
import type { DownloadItem, AppSettings } from '../types/desktop-ui.types';
import { tauriClient, getDaemonUrl, getDaemonToken } from '../api/tauriClient';
import { novaClient, setApiBase, setAuthToken } from '../api/novaClient';
import { isLanguageLoaded, loadLanguage } from '../lib/i18n/translations';
import { playAppSound } from '../utils/sound';
import { isDetachedWindow } from '../utils/windowMode';

import { taskStore, mergeDaemonTasks } from '../store/taskStore';
import { queueStore } from '../store/queueStore';
import { settingsStore } from '../store/settingsStore';
import { bridgeStore } from '../store/bridgeStore';
import { uiStore } from '../store/uiStore';

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

const toMinutes = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

const isQueueScheduledForDay = (queue: { scheduleType: string; days: number[] }, day: number): boolean => {
  if (queue.scheduleType === 'daily') return true;
  return queue.days.includes(day);
};

const isQueueInScheduleWindow = (queue: { scheduled: boolean; scheduleCompleted: boolean; scheduleType: string; days: number[]; startTime: string; endTime: string }, now: Date): boolean => {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  const start = toMinutes(queue.startTime);
  const end = toMinutes(queue.endTime);
  if (start == null || end == null) return false;
  if (start === end) return isQueueScheduledForDay(queue, today);
  if (start < end) return isQueueScheduledForDay(queue, today) && nowMinutes >= start && nowMinutes < end;
  if (nowMinutes >= start) return isQueueScheduledForDay(queue, today);
  return isQueueScheduledForDay(queue, yesterday) && nowMinutes < end;
};

function EffectsProvider({ children }: { children: ReactNode }) {
  const activeScheduleWindowsRef = useRef<Record<string, boolean>>({});

  // Initialize default download paths
  useEffect(() => {
    const { settings } = settingsStore.getState();
    if (settings.saveAndCategories.defaultFolder) return;
    let cancelled = false;
    void tauriClient.getDownloadsDir().then((downloadsDir) => {
      if (cancelled || !downloadsDir) return;
      const novaPaths = buildNovaDefaultPaths(downloadsDir);
      const s = settingsStore.getState().settings;
      if (s.saveAndCategories.defaultFolder) return;
      const updated: AppSettings = {
        ...s,
        saveAndCategories: {
          defaultFolder: novaPaths.defaultFolder,
          tempFolder: s.saveAndCategories.tempFolder || novaPaths.tempFolder,
          categoryFolders: {
            document: s.saveAndCategories.categoryFolders.document || novaPaths.categoryFolders.document,
            program: s.saveAndCategories.categoryFolders.program || novaPaths.categoryFolders.program,
            compressed: s.saveAndCategories.categoryFolders.compressed || novaPaths.categoryFolders.compressed,
            video: s.saveAndCategories.categoryFolders.video || novaPaths.categoryFolders.video,
            audio: s.saveAndCategories.categoryFolders.audio || novaPaths.categoryFolders.audio,
            other: s.saveAndCategories.categoryFolders.other || novaPaths.categoryFolders.other,
          },
        },
      };
      void tauriClient.saveConfigToDisk(updated);
      settingsStore.getState()._setSettings(updated);
    });
    return () => { cancelled = true; };
  }, []);

  // Theme
  useEffect(() => {
    const unsub = settingsStore.subscribe((state, prev) => {
      if (state.themeSettings !== prev.themeSettings || state.settings.extra.language !== prev.settings.extra.language) {
        applyTheme(state.themeSettings, state.settings.extra.language || 'en');
      }
    });
    const { themeSettings, settings } = settingsStore.getState();
    applyTheme(themeSettings, settings.extra.language || 'en');
    return unsub;
  }, []);

  // i18n
  useEffect(() => {
    const unsub = settingsStore.subscribe((state, prev) => {
      if (state.settings.extra.language !== prev.settings.extra.language) {
        const lang = state.settings.extra.language || 'en';
        if (!isLanguageLoaded(lang)) {
          void loadLanguage(lang).then(() => { settingsStore.getState().incrementI18nRevision(); });
        }
      }
    });
    const lang = settingsStore.getState().settings.extra.language || 'en';
    if (!isLanguageLoaded(lang)) {
      void loadLanguage(lang).then(() => { settingsStore.getState().incrementI18nRevision(); });
    }
    return unsub;
  }, []);

  // Settings persistence
  useEffect(() => {
    const unsub = settingsStore.subscribe((state, prev) => {
      if (state.settings !== prev.settings || state.themeSettings !== prev.themeSettings) {
        persistSettings(state.settings, state.themeSettings);
      }
    });
    return unsub;
  }, []);

  // Notifications muted persistence
  useEffect(() => {
    const unsub = uiStore.subscribe((state, prev) => {
      if (state.isNotificationsMuted !== prev.isNotificationsMuted) {
        localStorage.setItem('nova_notifications_muted', String(state.isNotificationsMuted));
      }
    });
    return unsub;
  }, []);

  // Queue persistence
  useEffect(() => {
    const unsub = queueStore.subscribe((state, prev) => {
      if (state.queues !== prev.queues) {
        localStorage.setItem('nova_queues', JSON.stringify(state.queues));
      }
    });
    return unsub;
  }, []);

  // Daemon connection
  useEffect(() => {
    const cancelled: { current: boolean } = { current: false };
    const retryIntervalRef: { current: number | null } = { current: null };
    let wasDegraded = false;

    const markConnected = (info: { status?: 'connected' | 'degraded'; buildVersion?: string; version: string; pid: number }) => {
      const status = info.status || 'connected';
      bridgeStore.getState().setIsDegradedMode(status === 'degraded');
      const s = settingsStore.getState().settings;
      bridgeStore.getState().setBridge({
        status,
        version: info.buildVersion || info.version,
        pid: info.pid,
        speedLimit: s.connection.speedLimiter.enabled ? s.connection.speedLimiter.maxSpeedKbs : null,
      });
    };

    const refreshDaemonUrl = async () => {
      const daemonUrl = await getDaemonUrl();
      setApiBase(daemonUrl);
      setAuthToken(await getDaemonToken());
    };

    const connectDaemon = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (cancelled.current) return false;
        try {
          await refreshDaemonUrl();
          const info = await tauriClient.checkDaemonHealth();
          markConnected(info);
          uiStore.getState().addToast(
            info.status === 'degraded' ? 'warning' : 'success',
            info.status === 'degraded' ? 'Service Partially Ready' : 'Service Connected',
            info.status === 'degraded'
              ? 'NOVA connected to the local service. Some engines are still starting.'
              : 'NOVA connected to the local download service successfully.',
          );
          const params = new URLSearchParams(window.location.search);
          const captureUrl = params.get('capture');
          if (captureUrl) {
            uiStore.getState().openDialog('addDownload', captureUrl);
            window.history.replaceState({}, '', window.location.pathname);
          }
          return true;
        } catch (e) {
          if (attempt < 39) {
            const delay = Math.min(100 * (1 << attempt), 2000);
            await new Promise((r) => setTimeout(r, delay));
          } else {
            bridgeStore.getState().setBridge({ status: 'degraded', version: 'NOVA daemon unavailable', pid: 0, speedLimit: null });
            bridgeStore.getState().setIsDegradedMode(true);
            taskStore.getState().setTasks([]);
            wasDegraded = true;
            uiStore.getState().addToast(
              'warning', 'NOVA daemon unavailable',
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
                uiStore.getState().addToast(
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
              bridgeStore.getState().setBridge({ status: 'degraded', version: 'Daemon unreachable', pid: 0, speedLimit: null });
              bridgeStore.getState().setIsDegradedMode(true);
            }
            scheduleHealth();
          })();
        }, 10000);
      };
      scheduleHealth();
    });

    return () => {
      cancelled.current = true;
      if (retryIntervalRef.current !== null) window.clearTimeout(retryIntervalRef.current);
    };
  }, []);

  // Browser extension config
  useEffect(() => {
    const unsub = bridgeStore.subscribe((state, prev) => {
      if (state.status !== prev.status) pushBrowserConfig(state.status);
    });
    pushBrowserConfig(bridgeStore.getState().status);
    return unsub;
  }, []);

  // Telegram config
  useEffect(() => {
    const unsub = settingsStore.subscribe((state, prev) => {
      if (state.settings.extra !== prev.settings.extra) {
        const s = state.settings;
        const timer = window.setTimeout(() => {
          void novaClient.updateTelegramConfig({
            enabled: s.extra.tgEnabled, token: s.extra.tgBotToken,
            chatId: parseInt(s.extra.tgChatId, 10) || 0, apiBase: s.extra.tgApiBase,
            fileUploadLimitMb: s.extra.tgFileUploadLimitMb,
          }).catch((e: unknown) => { console.warn('updateTelegramConfig failed', e); });
        }, 300);
        return () => { window.clearTimeout(timer); };
      }
    });
    return unsub;
  }, []);

  // Live task sync (SSE + polling fallback)
  useEffect(() => {
    const bridgeStatus = bridgeStore.getState().status;
    if (bridgeStatus !== 'connected' && bridgeStatus !== 'degraded') return;
    let cancelled = false;
    let started = false;
    let sseFailed = false;
    let fallbackTick = 0;
    let stopEvents: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const applyDownloadsImmediate = (daemonTasks: DownloadItem[], fromStream = false) => {
      if (cancelled) return;
      started = true;
      if (fromStream) sseFailed = false;
      const taskState = taskStore.getState();
      const completedIds = new Set(daemonTasks.filter((t) => t.status === 'completed').map((t) => t.id));
      const newlyCompletedTasks = daemonTasks.filter(
        (t) => t.status === 'completed' && !taskState.completedTaskIds.has(t.id),
      );
      const shouldRunCompletionActions = taskState.hasSyncedDownloads;
      taskStore.getState().setCompletedTaskIds(completedIds);
      taskStore.getState().setHasSyncedDownloads(true);

      if (shouldRunCompletionActions) {
        const currentSettings = settingsStore.getState().settings;
        newlyCompletedTasks.forEach((task) => {
          if (currentSettings.sounds.enabled) {
            playAppSound(currentSettings, 'complete');
            void tauriClient.triggerNativeNotification('Download complete', `"${task.name}" finished downloading.`);
          }
          if (!task.savePath) return;
          if (currentSettings.extra.virusScan) void tauriClient.scanDownloadedFile(task.savePath);
          if (currentSettings.extra.openOnComplete) void tauriClient.openDownloadedFile(task.savePath);
          if (currentSettings.extra.openFolderOnComplete) void tauriClient.revealDownloadedFile(task.savePath);
        });
        if (
          currentSettings.sounds.enabled && newlyCompletedTasks.length > 0 &&
          !daemonTasks.some((t) => t.status === 'downloading' || t.status === 'queued')
        ) {
          playAppSound(currentSettings, 'queueFinished');
        }
      }

      taskStore.getState().setTasks(mergeDaemonTasks(daemonTasks));
      bridgeStore.getState().setIsDegradedMode(bridgeStore.getState().status === 'degraded');
    };

    let pendingTasks: DownloadItem[] | null = null;
    const applyDownloads = (daemonTasks: DownloadItem[], fromStream = false) => {
      if (!fromStream) { applyDownloadsImmediate(daemonTasks, false); return; }
      pendingTasks = daemonTasks;
      if (debounceTimer === null) {
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          if (pendingTasks !== null) { const t = pendingTasks; pendingTasks = null; applyDownloadsImmediate(t, true); }
        }, 100);
      }
    };

    const syncDownloads = async () => {
      try {
        const daemonTasks = await novaClient.listDownloads();
        applyDownloads(daemonTasks);
      } catch {
        if (!cancelled && started) bridgeStore.getState().setIsDegradedMode(true);
      }
    };

    const { enableSse } = settingsStore.getState().settings.extra;
    const canStreamDownloads = enableSse && typeof window.EventSource !== 'undefined';
    if (canStreamDownloads) {
      stopEvents = novaClient.streamDownloads(
        (daemonTasks) => { applyDownloads(daemonTasks, true); },
        () => { sseFailed = true; },
      );
    }

    const initialTimer = setTimeout(() => { if (!cancelled) { started = true; void syncDownloads(); } }, 1000);
    const interval = setInterval(() => {
      if (document.hidden) return;
      fallbackTick += 1;
      if (canStreamDownloads && !sseFailed && fallbackTick % 5 !== 0) return;
      void syncDownloads();
    }, 2000);
    const onVisibilityChange = () => { if (!document.hidden) void syncDownloads(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      clearTimeout(initialTimer);
      clearInterval(interval);
      stopEvents?.();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  // Queue scheduler
  useEffect(() => {
    const bridgeStatus = bridgeStore.getState().status;
    if (bridgeStatus !== 'connected' && bridgeStatus !== 'degraded') return;
    if (isDetachedWindow()) return;

    const tickSchedules = () => {
      const now = new Date();
      const { queues } = queueStore.getState();
      const { tasks } = taskStore.getState();

      queues.forEach((queue) => {
        const wasActive = activeScheduleWindowsRef.current[queue.id] || false;
        const isActive = queue.scheduled && !queue.scheduleCompleted && isQueueInScheduleWindow(queue, now);

        if (isActive && !wasActive) {
          activeScheduleWindowsRef.current[queue.id] = true;
          tasks
            .filter((t) => t.queueId === queue.id && (t.status === 'queued' || t.status === 'paused' || t.status === 'error'))
            .slice(0, Math.max(1, queue.maxActive || 1))
            .forEach((t) => { void taskStore.getState().resumeTask(t.id); });
        }

        if (!isActive && wasActive) {
          activeScheduleWindowsRef.current[queue.id] = false;
          tasks
            .filter((t) => t.queueId === queue.id && t.status === 'downloading')
            .forEach((t) => { void taskStore.getState().pauseTask(t.id); });
          if (queue.scheduleType === 'once') {
            queueStore.getState().updateQueue(queue.id, { scheduled: false, scheduleCompleted: true }, true);
          }
        }

        if (!queue.scheduled) activeScheduleWindowsRef.current[queue.id] = false;
      });
    };

    tickSchedules();
    const interval = window.setInterval(tickSchedules, 30000);
    return () => { window.clearInterval(interval); };
  }, []);

  // Auto-progress dialog
  useEffect(() => {
    const unsub = taskStore.subscribe((state) => {
      const activeDownload = state.tasks.find((t) => t.status === 'downloading');
      if (!activeDownload || uiStore.getState().activeProgressMinimizedToTaskbar) return;
      const { dialog } = uiStore.getState();
      let nextProgressTask: DownloadItem | null = null;

      if (dialog.active === 'activeProgress') {
        const activePayload = dialog.payload as { id?: string } | null | undefined;
        const currentTask = activePayload?.id ? state.tasks.find((t) => t.id === activePayload.id) : null;
        if (!currentTask || currentTask.status !== 'downloading') nextProgressTask = activeDownload;
      } else if (!dialog.active) {
        nextProgressTask = activeDownload;
      }

      if (!nextProgressTask) return;
      const timer = window.setTimeout(() => {
        const cd = uiStore.getState().dialog;
        if (cd.active && cd.active !== 'activeProgress') return;
        uiStore.getState().openDialog('activeProgress', nextProgressTask);
      }, 0);
      return () => { window.clearTimeout(timer); };
    });
    return unsub;
  }, []);

  // Unsigned update check
  useEffect(() => {
    const { settings } = settingsStore.getState();
    if (!settings.general.checkUpdates) return;
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem('nova_last_unsigned_update_check') === today) return;
    localStorage.setItem('nova_last_unsigned_update_check', today);
    void tauriClient.checkTauriUpdate().then((result: { hasUpdate: boolean; latestVersion: string }) => {
      if (result.hasUpdate) {
        uiStore.getState().addToast('info', 'Update available', `A new version (${result.latestVersion}) is available.`);
      }
    }).catch((error: unknown) => { console.warn('unsigned update check failed', error); });
  }, []);

  return <>{children}</>;
}

function applyTheme(themeSettings: { theme: string; density: string; accent: string; progress: string; contrast: string }, language: string) {
  const root = document.documentElement;
  let activeTheme = themeSettings.theme;
  if (activeTheme === 'system') {
    activeTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', activeTheme);
  root.setAttribute('data-density', themeSettings.density);
  root.setAttribute('data-accent', themeSettings.accent);
  root.setAttribute('data-progress', themeSettings.progress);
  root.setAttribute('data-contrast', themeSettings.contrast);
  root.setAttribute('dir', 'ltr');
  root.setAttribute('lang', language || 'en');
}

function persistSettings(settings: AppSettings, themeSettings: { theme: string; density: string; accent: string; progress: string; contrast: string }) {
  const timer = setTimeout(() => {
    const safeSettings = {
      ...settings,
      connection: { ...settings.connection, proxyUser: '', proxyPass: '' },
      extra: { ...settings.extra, tgBotToken: '', tgChatId: '', smtpUser: '', smtpPass: '', browserPairingToken: '' },
    };
    localStorage.setItem('nova_settings_v1', JSON.stringify(safeSettings));
    localStorage.setItem('nova_theme_settings_v1', JSON.stringify(themeSettings));
  }, 300);
  return () => { clearTimeout(timer); };
}

function pushBrowserConfig(status: string) {
  if (status !== 'connected' && status !== 'degraded') return;
  if (isDetachedWindow()) return;
  const s = settingsStore.getState().settings;
  const enabled = Object.values(s.general.integrateWithBrowsers).some(Boolean);
  void novaClient.configureBrowserExtension({
    enabled, token: s.extra.browserPairingToken,
    minSizeMb: s.fileTypes.autoDownloadMaxSizeMb,
    defaultFolder: s.saveAndCategories.defaultFolder,
    categoryFolders: s.saveAndCategories.categoryFolders,
    userAgent: s.extra.userAgent,
  }).catch((e: unknown) => { console.warn('configureBrowserExtension failed', e); });
}

export const AppStoreProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  return <EffectsProvider>{children}</EffectsProvider>;
};
