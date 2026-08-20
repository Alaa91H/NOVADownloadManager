/* src/state/appStore.tsx */
import type { ReactNode } from 'react';
import React, { useEffect, useRef } from 'react';
import type { DownloadItem, AppSettings } from '../types/desktop-ui.types';
import { tauriClient, getDaemonUrl, getDaemonToken } from '../api/tauriClient';
import { novaClient, setApiBase, setAuthToken } from '../api/novaClient';
import { isLanguageLoaded, loadLanguage } from '../lib/i18n/translations';
import { playAppSound } from '../utils/sound';
import { logger } from '../utils/logger';
import { isDetachedWindow } from '../utils/windowMode';

import { taskStore, mergeDaemonTasks } from '../store/taskStore';
import { queueStore } from '../store/queueStore';
import { settingsStore } from '../store/settingsStore';
import { bridgeStore } from '../store/bridgeStore';
import { uiStore } from '../store/uiStore';

// Per-sync cap on completion side-effects (notification, virus scan, file
// open). Tasks beyond the cap are queued and drained incrementally on later
// syncs so every user-configured action still runs — just not all at once.
const COMPLETION_ACTIONS_PER_SYNC = 100;

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

const isQueueInScheduleWindow = (
  queue: {
    scheduled: boolean;
    scheduleCompleted: boolean;
    scheduleType: string;
    days: number[];
    startTime: string;
    endTime: string;
  },
  now: Date,
): boolean => {
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
  const displayedCaptureReviewIdRef = useRef<string | null>(null);

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
    return () => {
      cancelled = true;
    };
  }, []);

  // Browser captures are stored by the authenticated daemon until the user
  // explicitly queues or starts them. Polling is intentionally modest and only
  // opens a dialog when the desktop has no active dialog to avoid interrupting
  // the user's current work.
  useEffect(() => {
    let cancelled = false;
    const pollCaptureReviews = async () => {
      try {
        const reviews = await novaClient.listCaptureReviews();
        if (cancelled) return;
        if (reviews.length === 0) {
          displayedCaptureReviewIdRef.current = null;
          return;
        }
        const dialog = uiStore.getState().dialog;
        if (dialog.active) return;
        const next = reviews.find((review) => review.reviewId !== displayedCaptureReviewIdRef.current) ?? reviews[0];
        if (next.reviewId === displayedCaptureReviewIdRef.current) return;
        displayedCaptureReviewIdRef.current = next.reviewId;
        uiStore.getState().openDialog('addDownload', next);
      } catch {
        // The normal daemon connection loop reports service availability. A
        // failed optional review poll must never degrade the desktop UI.
      }
    };
    void pollCaptureReviews();
    const interval = window.setInterval(() => void pollCaptureReviews(), 800);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // Theme
  useEffect(() => {
    const unsub = settingsStore.subscribe((state, prev) => {
      if (
        state.themeSettings !== prev.themeSettings ||
        state.settings.extra.language !== prev.settings.extra.language
      ) {
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
          void loadLanguage(lang).then(() => {
            settingsStore.getState().incrementI18nRevision();
          });
        }
      }
    });
    const lang = settingsStore.getState().settings.extra.language || 'en';
    if (!isLanguageLoaded(lang)) {
      void loadLanguage(lang).then(() => {
        settingsStore.getState().incrementI18nRevision();
      });
    }
    return unsub;
  }, []);

  // Initialize logger from settings
  useEffect(() => {
    const { loggingEnabled, logLevel } = settingsStore.getState().settings.advanced;
    logger.setEnabled(loggingEnabled);
    logger.setMinLevel(logLevel);
    logger.info('AppStore', 'Application initialized', {
      loggingEnabled,
      logLevel,
      timestamp: new Date().toISOString(),
    });

    const unsub = settingsStore.subscribe((state, prev) => {
      if (state.settings.advanced !== prev.settings.advanced) {
        const { loggingEnabled: en, logLevel: ll } = state.settings.advanced;
        logger.setEnabled(en);
        logger.setMinLevel(ll);
      }
    });
    return unsub;
  }, []);

  // Settings persistence
  useEffect(() => {
    let pendingCleanup: (() => void) | null = null;
    const unsub = settingsStore.subscribe((state, prev) => {
      if (state.settings !== prev.settings || state.themeSettings !== prev.themeSettings) {
        pendingCleanup?.();
        pendingCleanup = persistSettings(state.settings, state.themeSettings);
      }
    });
    return () => {
      pendingCleanup?.();
      unsub();
    };
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

    const markConnected = (info: {
      status?: 'connected' | 'degraded';
      buildVersion?: string;
      version: string;
      pid: number;
    }) => {
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
          logger.info('AppStore', `Daemon connected: ${info.status}`, { version: info.version, pid: info.pid });
          uiStore
            .getState()
            .addToast(
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
            const delay = Math.min(100 * Math.pow(2, attempt), 2000);
            await new Promise((r) => setTimeout(r, delay));
          } else {
            logger.error('AppStore', 'Daemon connection failed after 40 attempts', {
              error: e instanceof Error ? e.message : String(e),
            });
            bridgeStore
              .getState()
              .setBridge({ status: 'degraded', version: 'NOVA daemon unavailable', pid: 0, speedLimit: null });
            bridgeStore.getState().setIsDegradedMode(true);
            taskStore.getState().setTasks([]);
            wasDegraded = true;
            uiStore
              .getState()
              .addToast(
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
                uiStore
                  .getState()
                  .addToast(
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
              bridgeStore
                .getState()
                .setBridge({ status: 'degraded', version: 'Daemon unreachable', pid: 0, speedLimit: null });
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

  // Telegram config — uses pendingCleanup pattern because zustand's
  // subscribe discards listener return values (no cleanup callback support).
  useEffect(() => {
    let pendingCleanup: (() => void) | null = null;
    const unsub = settingsStore.subscribe((state, prev) => {
      if (state.settings.extra !== prev.settings.extra) {
        pendingCleanup?.();
        const s = state.settings;
        const timer = window.setTimeout(() => {
          void novaClient
            .updateTelegramConfig({
              enabled: s.extra.tgEnabled,
              token: s.extra.tgBotToken,
              chatId: parseInt(s.extra.tgChatId, 10) || 0,
              apiBase: s.extra.tgApiBase,
              fileUploadLimitMb: s.extra.tgFileUploadLimitMb,
            })
            .catch((e: unknown) => {
              logger.warn('appStore', 'updateTelegramConfig failed', e);
            });
        }, 300);
        pendingCleanup = () => {
          window.clearTimeout(timer);
        };
      }
    });
    return () => {
      pendingCleanup?.();
      unsub();
    };
  }, []);

  // Live task sync (SSE + polling fallback). The bridge starts in
  // 'connecting' and only becomes ready after the daemon health check
  // succeeds, which is async — so this effect must *subscribe* to status
  // changes instead of gating on the mount-time value, or task sync would
  // never start on a fresh page load.
  useEffect(() => {
    let cancelled = false;
    let started = false;
    let sseFailed = false;
    let fallbackTick = 0;
    let stopEvents: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let initialTimer: ReturnType<typeof setTimeout> | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let syncActive = false;
    // A polling response can arrive after a newer SSE snapshot (or after a
    // newer poll). Without an ordering guard it would overwrite live byte
    // counters with stale values, producing the visible 0% → complete jump.
    let appliedSyncEpoch = 0;
    let latestPollRequest = 0;
    // Completion side-effect queue: burst of thousands of completions must not
    // fire thousands of native notifications / file-opens in one tick, but
    // every task's configured actions (openOnComplete, virusScan, …) must still
    // run eventually — so we drain a bounded batch per sync and carry the rest.
    const pendingCompletion: DownloadItem[] = [];
    const pendingCompletionIds = new Set<string>();

    const drainCompletions = (settings: AppSettings) => {
      if (pendingCompletion.length === 0) return;
      const batch = pendingCompletion.splice(0, COMPLETION_ACTIONS_PER_SYNC);
      for (const task of batch) {
        pendingCompletionIds.delete(task.id);
        logger.info('AppStore', `Download completed: ${task.name}`, { id: task.id, size: task.sizeBytes });
        void tauriClient.triggerNativeNotification('Download complete', `"${task.name}" finished downloading.`);
        if (!task.savePath) continue;
        if (settings.extra.virusScan) void tauriClient.scanDownloadedFile(task.savePath);
        if (settings.extra.openOnComplete) void tauriClient.openDownloadedFile(task.savePath);
        if (settings.extra.openFolderOnComplete) void tauriClient.revealDownloadedFile(task.savePath);
      }
    };

    const applyDownloadsImmediate = (daemonTasks: DownloadItem[], fromStream = false) => {
      if (cancelled) return;
      appliedSyncEpoch += 1;
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
        const totalCompleted = newlyCompletedTasks.length;
        // Play the completion sound once per sync regardless of burst size, so
        // a huge batch finishing at once can't stack thousands of simultaneous
        // sound effects.
        if (totalCompleted > 0 && currentSettings.sounds.enabled) {
          playAppSound(currentSettings, 'complete');
        }
        // Enqueue every newly completed task, then drain a bounded batch this
        // sync. Tasks beyond the batch stay queued and are processed on later
        // syncs — so a 10k completion burst can't flood the OS, but no task
        // silently loses its configured open/scan/notification actions.
        for (const task of newlyCompletedTasks) {
          if (pendingCompletionIds.has(task.id)) continue;
          pendingCompletionIds.add(task.id);
          pendingCompletion.push(task);
        }
        drainCompletions(currentSettings);
        if (pendingCompletion.length > 0) {
          logger.info('AppStore', 'Completion side-effects queued', {
            pending: pendingCompletion.length,
            perSync: COMPLETION_ACTIONS_PER_SYNC,
          });
        }
        if (totalCompleted > 0 && !daemonTasks.some((t) => t.status === 'downloading' || t.status === 'queued')) {
          playAppSound(currentSettings, 'queueFinished');
        }
      }

      // mergeDaemonTasks returns the previous array by reference when nothing
      // changed, so skip setTasks entirely — no subscriber (TaskTable, sidebar
      // counts, search/filter) is woken on a no-op poll.
      const merged = mergeDaemonTasks(daemonTasks);
      if (merged !== taskStore.getState().tasks) {
        taskStore.getState().setTasks(merged);
      }
      bridgeStore.getState().setIsDegradedMode(bridgeStore.getState().status === 'degraded');
    };

    let pendingTasks: DownloadItem[] | null = null;
    const applyDownloads = (daemonTasks: DownloadItem[], fromStream = false) => {
      if (!fromStream) {
        applyDownloadsImmediate(daemonTasks, false);
        return;
      }
      pendingTasks = daemonTasks;
      if (debounceTimer === null) {
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          if (pendingTasks !== null) {
            const t = pendingTasks;
            pendingTasks = null;
            applyDownloadsImmediate(t, true);
          }
        }, 100);
      }
    };

    const syncDownloads = async () => {
      const requestId = ++latestPollRequest;
      const epochBeforeRequest = appliedSyncEpoch;
      try {
        const daemonTasks = await novaClient.listDownloads();
        // Ignore an older overlapping poll or a response that was overtaken by
        // SSE. The next regular poll remains a full reconciliation point.
        if (cancelled || requestId !== latestPollRequest || epochBeforeRequest !== appliedSyncEpoch) return;
        applyDownloads(daemonTasks);
      } catch {
        if (!cancelled && started) bridgeStore.getState().setIsDegradedMode(true);
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden) void syncDownloads();
    };

    const stopSync = () => {
      if (!syncActive) return;
      syncActive = false;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (initialTimer !== null) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
      stopEvents?.();
      stopEvents = null;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };

    const startSync = () => {
      if (cancelled || syncActive) return;
      syncActive = true;
      started = false;
      sseFailed = false;
      fallbackTick = 0;
      appliedSyncEpoch = 0;
      latestPollRequest = 0;
      const { enableSse } = settingsStore.getState().settings.extra;
      const canStreamDownloads = enableSse && typeof window.EventSource !== 'undefined';
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
      initialTimer = setTimeout(() => {
        if (!cancelled) {
          started = true;
          void syncDownloads();
        }
      }, 1000);
      interval = setInterval(() => {
        if (document.hidden) return;
        fallbackTick += 1;
        if (canStreamDownloads && !sseFailed && fallbackTick % 5 !== 0) return;
        void syncDownloads();
      }, 2000);
      document.addEventListener('visibilitychange', onVisibilityChange);
    };

    // Start syncing when the bridge becomes ready (connected or degraded) and
    // stop when it drops out — e.g. a daemon restart. The mount-time status is
    // always 'connecting', so without this subscription task sync would never
    // run.
    const unsub = bridgeStore.subscribe((state, prev) => {
      const ready = state.status === 'connected' || state.status === 'degraded';
      const wasReady = prev.status === 'connected' || prev.status === 'degraded';
      if (ready && !wasReady) startSync();
      else if (!ready && wasReady) stopSync();
    });
    const initialStatus = bridgeStore.getState().status;
    if (initialStatus === 'connected' || initialStatus === 'degraded') startSync();

    return () => {
      cancelled = true;
      unsub();
      stopSync();
    };
  }, []);

  // Queue scheduler. Same mount-time status trap as the task-sync effect: the
  // bridge starts 'connecting', so a one-shot gate would never tick scheduled
  // queues on a fresh page load. Subscribe to status transitions instead and
  // only run the scheduler while the bridge is ready.
  useEffect(() => {
    if (isDetachedWindow()) return;
    let interval: number | null = null;

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
            .filter(
              (t) => t.queueId === queue.id && (t.status === 'queued' || t.status === 'paused' || t.status === 'error'),
            )
            .slice(0, Math.max(1, queue.maxActive || 1))
            .forEach((t) => {
              void taskStore.getState().resumeTask(t.id);
            });
        }

        if (!isActive && wasActive) {
          activeScheduleWindowsRef.current[queue.id] = false;
          tasks
            .filter((t) => t.queueId === queue.id && t.status === 'downloading')
            .forEach((t) => {
              void taskStore.getState().pauseTask(t.id);
            });
          if (queue.scheduleType === 'once') {
            queueStore.getState().updateQueue(queue.id, { scheduled: false, scheduleCompleted: true }, true);
          }
        }

        if (!queue.scheduled) activeScheduleWindowsRef.current[queue.id] = false;
      });
    };

    const start = () => {
      if (interval !== null) return;
      tickSchedules();
      interval = window.setInterval(tickSchedules, 30000);
    };
    const stop = () => {
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };

    const unsub = bridgeStore.subscribe((state, prev) => {
      const ready = state.status === 'connected' || state.status === 'degraded';
      const wasReady = prev.status === 'connected' || prev.status === 'degraded';
      if (ready && !wasReady) start();
      else if (!ready && wasReady) stop();
    });
    const initialStatus = bridgeStore.getState().status;
    if (initialStatus === 'connected' || initialStatus === 'degraded') start();

    return () => {
      unsub();
      stop();
    };
  }, []);

  // Auto-progress dialog — uses pendingCleanup pattern because zustand's
  // subscribe discards listener return values (no cleanup callback support).
  useEffect(() => {
    let pendingCleanup: (() => void) | null = null;
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
      pendingCleanup?.();
      const timer = window.setTimeout(() => {
        const cd = uiStore.getState().dialog;
        if (cd.active && cd.active !== 'activeProgress') return;
        uiStore.getState().openDialog('activeProgress', nextProgressTask);
      }, 0);
      pendingCleanup = () => {
        window.clearTimeout(timer);
      };
    });
    return () => {
      pendingCleanup?.();
      unsub();
    };
  }, []);

  // Unsigned update check
  useEffect(() => {
    const { settings } = settingsStore.getState();
    if (!settings.general.checkUpdates) return;
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem('nova_last_unsigned_update_check') === today) return;
    localStorage.setItem('nova_last_unsigned_update_check', today);
    void tauriClient
      .checkTauriUpdate()
      .then((result: { hasUpdate: boolean; latestVersion: string }) => {
        if (result.hasUpdate) {
          uiStore
            .getState()
            .addToast('info', 'Update available', `A new version (${result.latestVersion}) is available.`);
        }
      })
      .catch((error: unknown) => {
        logger.warn('appStore', 'unsigned update check failed', error);
      });
  }, []);

  return <>{children}</>;
}

function applyTheme(
  themeSettings: { theme: string; density: string; accent: string; progress: string; contrast: string },
  language: string,
) {
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

function persistSettings(
  settings: AppSettings,
  themeSettings: { theme: string; density: string; accent: string; progress: string; contrast: string },
) {
  const timer = setTimeout(() => {
    const safeSettings = {
      ...settings,
      connection: { ...settings.connection, proxyUser: '', proxyPass: '' },
      extra: { ...settings.extra, tgBotToken: '', tgChatId: '', smtpUser: '', smtpPass: '' },
    };
    localStorage.setItem('nova_settings_v1', JSON.stringify(safeSettings));
    localStorage.setItem('nova_theme_settings_v1', JSON.stringify(themeSettings));
  }, 300);
  return () => {
    clearTimeout(timer);
  };
}

function pushBrowserConfig(status: string) {
  if (status !== 'connected' && status !== 'degraded') return;
  if (isDetachedWindow()) return;
  const s = settingsStore.getState().settings;
  const enabled = Object.values(s.general.integrateWithBrowsers).some(Boolean);
  void novaClient
    .configureBrowserExtension({
      enabled,
      token: s.extra.browserPairingToken,
      minSizeMb: s.fileTypes.autoDownloadMaxSizeMb,
      defaultFolder: s.saveAndCategories.defaultFolder,
      categoryFolders: s.saveAndCategories.categoryFolders,
      userAgent: s.extra.userAgent,
    })
    .catch((e: unknown) => {
      logger.warn('appStore', 'configureBrowserExtension failed', e);
    });
}

export const AppStoreProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  return <EffectsProvider>{children}</EffectsProvider>;
};
