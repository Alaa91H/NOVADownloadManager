import { create } from 'zustand';
import { novaClient } from '../api/novaClient';

// ── Types mirroring the daemon engine-control surface ──────────────────────
export interface BandwidthTaskStat {
  taskId: string;
  averageSpeedBps: number;
  allowedKbps: number;
}

export interface BandwidthState {
  globalLimitKbps: number;
  paused: boolean;
  tasks: BandwidthTaskStat[];
}

export interface EngineQueueEntry {
  taskId?: string;
  priority?: number;
  [key: string]: unknown;
}

export interface RetryPolicy {
  preset?: string;
  maxRetries?: number;
  baseDelaySecs?: number;
  maxDelaySecs?: number;
  backoffMultiplier?: number;
  jitter?: boolean;
  [key: string]: unknown;
}

export interface MirrorEntry {
  url: string;
  priority: number;
  healthy: boolean;
  region?: string | null;
}

export interface MirrorDownloadEntry {
  taskId: string;
  activeUrl?: string | null;
  mirrors: MirrorEntry[];
}

export interface AdaptiveInfo {
  connections?: number;
  maxConnections?: number;
  speed?: number;
  peakSpeed?: number;
  retryState?: { totalRetries: number; lastError: string };
}

export interface SegmentInfo {
  segmented?: boolean;
  totalSegments?: number;
  completedSegments?: number;
  progress?: number;
}

export interface EngineStats {
  totalCompleted: number;
  totalFailed: number;
  totalDownloadedBytes: number;
  activeDownloads: number;
  sessionStartedAt?: string;
}

interface EngineStore {
  // Snapshot data
  bandwidth: BandwidthState | null;
  rateLimit: { globalLimitKbps: number; paused: boolean } | null;
  queue: {
    entries: EngineQueueEntry[];
    activeCount: number;
    totalBandwidthKbps: number;
    nextToStart: string | null;
  } | null;
  profiles: { profiles: unknown[]; activeProfile: string } | null;
  retryPolicy: { policy: RetryPolicy; backoffPreviewSecs: number[] } | null;
  mirrors: MirrorDownloadEntry[];
  plugins: { plugins: unknown[]; apiVersion: string } | null;
  cache: { entries: number } | null;
  stats: EngineStats | null;

  // Per-task telemetry (keyed by taskId)
  adaptive: Record<string, AdaptiveInfo>;
  segments: Record<string, SegmentInfo>;

  loading: boolean;
  error: string | null;
  lastRefresh: number;

  // Actions
  refreshAll: () => Promise<void>;
  refreshBandwidth: () => Promise<void>;
  refreshRateLimit: () => Promise<void>;
  refreshQueue: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  refreshRetryPolicy: () => Promise<void>;
  refreshMirrors: () => Promise<void>;
  refreshPlugins: () => Promise<void>;
  refreshCache: () => Promise<void>;
  refreshStats: () => Promise<void>;
  refreshAdaptive: (taskId: string) => Promise<void>;
  refreshSegments: (taskId: string) => Promise<void>;

  // Mutations (apply then refresh)
  setBandwidth: (config: {
    globalLimitKbps?: number;
    paused?: boolean;
    taskLimits?: Record<string, number>;
    removeTaskLimits?: string[];
  }) => Promise<void>;
  setRateLimit: (config: {
    globalLimitKbps?: number;
    taskLimit?: Record<string, number>;
    removeTaskLimits?: string[];
  }) => Promise<void>;
  setQueuePriority: (taskId: string, priority: number) => Promise<void>;
  setActiveProfile: (profileId: string) => Promise<void>;
  setRetryPolicy: (config: {
    preset?: 'default' | 'aggressive' | 'conservative' | 'none';
    maxRetries?: number;
    baseDelaySecs?: number;
    maxDelaySecs?: number;
    backoffMultiplier?: number;
    jitter?: boolean;
  }) => Promise<void>;
  addMirror: (taskId: string, mirrorUrl: string, priority?: number) => Promise<void>;
  triggerFailover: (taskId: string) => Promise<void>;
  setFailover: (taskId: string, enabled: boolean) => Promise<void>;
  clearCache: () => Promise<void>;
}

export const useEngineStore = create<EngineStore>((set, get) => ({
  bandwidth: null,
  rateLimit: null,
  queue: null,
  profiles: null,
  retryPolicy: null,
  mirrors: [],
  plugins: null,
  cache: null,
  stats: null,
  adaptive: {},
  segments: {},

  loading: false,
  error: null,
  lastRefresh: 0,

  refreshBandwidth: async () => {
    try {
      const bw = await novaClient.getBandwidth();
      set({ bandwidth: { globalLimitKbps: bw.globalLimitKbps, paused: bw.paused, tasks: bw.tasks } });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load bandwidth state' });
    }
  },

  refreshRateLimit: async () => {
    try {
      const rl = await novaClient.getRateLimit();
      set({ rateLimit: { globalLimitKbps: rl.globalLimitKbps, paused: rl.paused } });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load rate limit' });
    }
  },

  refreshQueue: async () => {
    try {
      const q = await novaClient.getEngineQueue();
      set({
        queue: {
          entries: q.entries as EngineQueueEntry[],
          activeCount: q.activeCount,
          totalBandwidthKbps: q.totalBandwidthKbps,
          nextToStart: q.nextToStart ?? null,
        },
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load engine queue' });
    }
  },

  refreshProfiles: async () => {
    try {
      const p = await novaClient.listProfiles();
      set({ profiles: { profiles: p.profiles, activeProfile: p.activeProfile } });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load profiles' });
    }
  },

  refreshRetryPolicy: async () => {
    try {
      const rp = await novaClient.getRetryPolicy();
      set({
        retryPolicy: {
          policy: (rp.policy as RetryPolicy | undefined) ?? {},
          backoffPreviewSecs: rp.backoffPreviewSecs,
        },
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load retry policy' });
    }
  },

  refreshMirrors: async () => {
    try {
      const m = await novaClient.listMirrors();
      const downloads = (m.downloads as Array<Record<string, unknown>>).map((d) => {
        const mirrors = Array.isArray(d.mirrors) ? (d.mirrors as Array<Record<string, unknown>>) : [];
        return {
          taskId: typeof d.task_id === 'string' ? d.task_id : '',
          activeUrl: typeof d.active_url === 'string' ? d.active_url : null,
          mirrors: mirrors.map((s) => ({
            url: typeof s.url === 'string' ? s.url : '',
            priority: typeof s.priority === 'number' ? s.priority : 0,
            healthy: Boolean(s.healthy),
            region: (s.region as string | null | undefined) ?? null,
          })),
        };
      });
      set({ mirrors: downloads });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load mirrors' });
    }
  },

  refreshPlugins: async () => {
    try {
      const pl = await novaClient.listPlugins();
      set({ plugins: { plugins: pl.plugins, apiVersion: pl.apiVersion } });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load plugins' });
    }
  },

  refreshCache: async () => {
    try {
      const c = await novaClient.getMetadataCacheStats();
      set({ cache: { entries: c.entries } });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load cache stats' });
    }
  },

  refreshStats: async () => {
    try {
      const s = await novaClient.getStats();
      set({ stats: s });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load stats' });
    }
  },

  refreshAdaptive: async (taskId) => {
    try {
      const a = await novaClient.getAdaptiveInfo(taskId);
      if (a.ok) {
        set((prev) => ({
          adaptive: {
            ...prev.adaptive,
            [taskId]: {
              connections: a.connections,
              maxConnections: a.maxConnections,
              speed: a.speed,
              peakSpeed: a.peakSpeed,
              retryState: a.retryState,
            },
          },
        }));
      }
    } catch {
      // Per-task telemetry is best-effort; leave existing snapshot in place.
    }
  },

  refreshSegments: async (taskId) => {
    try {
      const s = await novaClient.getSegmentInfo(taskId);
      if (s.ok) {
        set((prev) => ({
          segments: {
            ...prev.segments,
            [taskId]: {
              segmented: s.segmented,
              totalSegments: s.totalSegments,
              completedSegments: s.completedSegments,
              progress: s.progress,
            },
          },
        }));
      }
    } catch {
      // Per-task telemetry is best-effort.
    }
  },

  refreshAll: async () => {
    set({ loading: true, error: null });
    await Promise.allSettled([
      get().refreshBandwidth(),
      get().refreshRateLimit(),
      get().refreshQueue(),
      get().refreshProfiles(),
      get().refreshRetryPolicy(),
      get().refreshMirrors(),
      get().refreshPlugins(),
      get().refreshCache(),
      get().refreshStats(),
    ]);
    set({ loading: false, lastRefresh: Date.now() });
  },

  setBandwidth: async (config) => {
    await novaClient.setBandwidth(config);
    await get().refreshBandwidth();
  },

  setRateLimit: async (config) => {
    await novaClient.setRateLimit(config);
    await get().refreshRateLimit();
  },

  setQueuePriority: async (taskId, priority) => {
    await novaClient.setQueuePriority(taskId, priority);
    await get().refreshQueue();
  },

  setActiveProfile: async (profileId) => {
    await novaClient.setActiveProfile(profileId);
    await get().refreshProfiles();
  },

  setRetryPolicy: async (config) => {
    await novaClient.setRetryPolicy(config);
    await get().refreshRetryPolicy();
  },

  addMirror: async (taskId, mirrorUrl, priority) => {
    await novaClient.addMirror(taskId, mirrorUrl, priority);
    await get().refreshMirrors();
  },

  triggerFailover: async (taskId) => {
    await novaClient.triggerMirrorFailover(taskId);
    await get().refreshMirrors();
  },

  setFailover: async (taskId, enabled) => {
    await novaClient.setMirrorFailover(taskId, enabled);
    await get().refreshMirrors();
  },

  clearCache: async () => {
    await novaClient.clearMetadataCache();
    await get().refreshCache();
  },
}));
