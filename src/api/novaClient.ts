import type { DownloadItem } from '../types/desktop-ui.types';
import type { DiagnosticData } from './tauriClient';

export interface NovaHealth {
  status: 'connected' | 'degraded';
  name: string;
  version: string;
  pid: number;
  engines: {
    curl: {
      available: boolean;
      version: string;
      versionText?: string;
      runtimeCore?: string;
      externalCurlBinary?: boolean;
      libcurlMulti?: Record<string, unknown>;
      source?: string;
      protocols?: string[];
      compiledFeatures?: string[];
      capabilities?: Record<string, unknown>;
      supportedDirectOptionKeys?: string[];
      unsupportedDirectOptionKeys?: string[];
      error?: string;
    };
    ytdlp: {
      available: boolean;
      version: string;
      capabilities?: Record<string, unknown>;
      supportedMediaOptionKeys?: string[];
      unsupportedMediaOptionKeys?: string[];
      supportedExternalDownloaders?: string[];
      error?: string;
    };
    ffmpeg?: {
      available: boolean;
      version?: string;
      versionText?: string;
      capabilities?: Record<string, unknown>;
      formats?: string[];
      codecs?: string[];
      inputProtocols?: string[];
      outputProtocols?: string[];
      filters?: string[];
      error?: string;
    };
  };
  allEnginesReady?: boolean;
  routing?: Record<string, unknown>;
  compatibilityMode?: string;
}

export interface NovaProbeResult {
  url: string;
  finalUrl?: string;
  fileName: string;
  fileType: DownloadItem['fileType'];
  sizeBytes: number;
  resumable: boolean;
  supportsSegments?: boolean;
  contentType: string;
  contentDisposition?: string;
  acceptRanges?: string;
  contentRange?: string;
  etag?: string;
  lastModified?: string;
  httpStatus?: number;
  probeMethod?: string;
}

export interface MediaFormat {
  formatId: string;
  height: number | null;
  width: number | null;
  ext: string;
  filesize: number;
  filesizeApprox: number;
  vcodec: string;
  acodec: string;
  formatNote: string | null;
  tbr: number | null;
  abr: number | null;
  vbr: number | null;
  fps: number | null;
}

export interface MediaProbeResult {
  id: string;
  title: string;
  duration: number;
  durationString: string;
  thumbnail: string;
  webpageUrl: string;
  formats: MediaFormat[];
}

export interface FfmpegStatus {
  available: boolean;
  binary?: string;
  version?: string;
  versionText?: string;
}

export interface BrowserExtensionConfig {
  enabled: boolean;
  token: string;
  minSizeMb: number;
  defaultFolder: string;
  categoryFolders: Record<string, string>;
  userAgent: string;
}

export interface BrowserExtensionHealth {
  status: string;
  enabled: boolean;
  paired: boolean;
  version: string;
  captureEndpoint: string;
  directDownloads: boolean;
  mediaDownloads: boolean;
  postProcessing?: boolean;
  directEngine?: string;
  mediaEngine?: string;
  postProcessor?: string;
  engineCapabilities?: unknown;
}

export interface MediaPlaylistEntry {
  id: string;
  title: string;
  url: string;
  duration: number;
  durationString: string;
  thumbnail: string;
  index: number;
}

export interface MediaPlaylistResult {
  title: string;
  webpageUrl: string;
  entries: MediaPlaylistEntry[];
}

type CreateDownloadPayload = Omit<
  DownloadItem,
  'id' | 'dateAdded' | 'downloadedBytes' | 'speedBytesPerSec' | 'timeLeftSeconds' | 'segments'
> & {
  startImmediately: boolean;
};

/** Safely coerce an untyped JSON value to a string, returning a fallback for non-strings. */
function asStr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Safely coerce an untyped JSON value to a number, returning a fallback for non-numbers. */
function asNum(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

let _apiBase: string | undefined;
let _authToken: string | undefined;

// Development override: allow setting a bearer token through Vite env
// (useful when running the daemon separately without Tauri).
try {
  const devToken = import.meta.env.VITE_NOVA_API_TOKEN || undefined;
  if (devToken) _authToken = devToken;
} catch {
  // ignore when import.meta is not available in some test environments
}

/** Set the bearer token the daemon expects on non-exempt API routes. */
export function setAuthToken(token: string): void {
  _authToken = token || undefined;
}

function getApiBase(): string {
  if (_apiBase !== undefined) return _apiBase;
  const envUrl = import.meta.env.VITE_NOVA_API_URL;
  if (envUrl) {
    _apiBase = envUrl.replace(/\/$/, '');
    return _apiBase;
  }
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    _apiBase = 'http://127.0.0.1:3199';
    return _apiBase;
  }
  _apiBase = '';
  return _apiBase;
}

/** Override the API base URL (used by Tauri to set the correct daemon port). */
export function setApiBase(url: string): void {
  _apiBase = url.replace(/\/$/, '');
}

export const novaClient = {
  async health(): Promise<NovaHealth> {
    return request<NovaHealth>('/api/health', undefined, 8000);
  },

  async engineCapabilities(): Promise<unknown> {
    return request<unknown>('/api/engines/capabilities', undefined, 8000);
  },

  async downloadEngine(
    engine: 'ytdlp' | 'ffmpeg',
  ): Promise<{ ok: boolean; engine: string; path?: string; version?: string; error?: string }> {
    return request(
      '/api/engines/download',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine }),
      },
      120000,
    );
  },

  async verifyEngine(
    engine: 'ytdlp' | 'ffmpeg',
  ): Promise<{ ok: boolean; available: boolean; engine: string; path?: string; version?: string; error?: string }> {
    return request(
      '/api/engines/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine }),
      },
      10000,
    );
  },

  async checkEngineLatestVersion(engine: 'ytdlp' | 'ffmpeg'): Promise<{
    ok: boolean;
    engine: string;
    latestVersion: string;
    currentVersion?: string;
    updateAvailable?: boolean;
    error?: string;
  }> {
    return request(
      '/api/engines/latest-version',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine }),
      },
      15000,
    );
  },

  async diagnostics(): Promise<DiagnosticData> {
    return request<DiagnosticData>('/api/diagnostics', undefined, 50000);
  },

  async listDownloads(): Promise<DownloadItem[]> {
    return request<DownloadItem[]>('/api/downloads', undefined, 2000);
  },

  streamDownloads(onDownloads: (downloads: DownloadItem[]) => void, onError?: (event: Event) => void): () => void {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
      return () => {};
    }

    let source: EventSource | null = null;
    let retryDelay = 500;
    const MAX_RETRY_DELAY = 10000;
    let cancelled = false;
    let healthTimer: ReturnType<typeof setInterval> | null = null;
    let lastEventTime = Date.now();

    const HEALTH_CHECK_INTERVAL = 10000;
    const STALE_THRESHOLD = 10000;

    // Delta sync: merge changed/removed into current list.
    let currentTasks: DownloadItem[] = [];
    const handleDelta = (event: MessageEvent<string>) => {
      lastEventTime = Date.now();
      try {
        const delta = JSON.parse(event.data) as {
          changed: DownloadItem[];
          removed: string[];
        };
        const removedSet = new Set(delta.removed);
        const changedMap = new Map(delta.changed.map((t) => [t.id, t]));
        // Merge: replace changed tasks, remove deleted ones, collect existing IDs.
        const existingIds = new Set<string>();
        const merged = currentTasks
          .filter((t) => !removedSet.has(t.id))
          .map((t) => {
            existingIds.add(t.id);
            return changedMap.get(t.id) ?? t;
          });
        // Add truly new tasks that aren't in current list.
        for (const t of delta.changed) {
          if (!existingIds.has(t.id)) {
            merged.push(t);
          }
        }
        currentTasks = merged;
        onDownloads(currentTasks);
      } catch (parseErr) {
        console.warn('NovaClient: could not parse delta event', parseErr);
      }
    };

    // When a full sync arrives, update our local cache.
    const handleFullAndUpdate = (event: MessageEvent<string>) => {
      lastEventTime = Date.now();
      try {
        const tasks = JSON.parse(event.data) as DownloadItem[];
        currentTasks = tasks;
        onDownloads(tasks);
      } catch (parseErr) {
        console.warn('NovaClient: could not parse download event', parseErr);
      }
    };

    const connect = () => {
      if (cancelled) return;
      // EventSource cannot send an Authorization header, so pass the token as a
      // query parameter (the daemon accepts it for streaming endpoints).
      const tokenParam = _authToken ? `?token=${encodeURIComponent(_authToken)}` : '';
      source = new EventSource(`${getApiBase()}/api/downloads/events${tokenParam}`);
      source.addEventListener('downloads', handleFullAndUpdate as EventListener);
      source.addEventListener('downloads-delta', handleDelta as EventListener);
      source.onerror = (event) => {
        onError?.(event);
        // Close current source and schedule reconnection with exponential backoff
        if (source) {
          source.removeEventListener('downloads', handleFullAndUpdate as EventListener);
          source.removeEventListener('downloads-delta', handleDelta as EventListener);
          source.close();
          source = null;
        }
        if (!cancelled) {
          setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
        }
      };
      // On open, reset backoff
      source.onopen = () => {
        retryDelay = 500;
        lastEventTime = Date.now();
      };
    };

    // Health monitor: if no SSE events received within STALE_THRESHOLD,
    // force a full sync via polling to detect silent disconnections.
    healthTimer = setInterval(() => {
      if (cancelled) return;
      if (Date.now() - lastEventTime > STALE_THRESHOLD) {
        // SSE might be silently dead — trigger an error to reconnect
        if (source) {
          source.dispatchEvent(new Event('error'));
        }
      }
    }, HEALTH_CHECK_INTERVAL);

    connect();

    return () => {
      cancelled = true;
      if (healthTimer) clearInterval(healthTimer); // eslint-disable-line @typescript-eslint/no-unnecessary-condition
      if (source) {
        source.removeEventListener('downloads', handleFullAndUpdate as EventListener);
        source.removeEventListener('downloads-delta', handleDelta as EventListener);
        source.close();
        source = null;
      }
    };
  },

  async probeDownload(
    url: string,
    payload?: Partial<CreateDownloadPayload> & { directOptions?: Record<string, unknown> },
  ): Promise<NovaProbeResult> {
    if (payload) {
      return request<NovaProbeResult>(
        '/api/probe',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, url }),
        },
        30000,
      );
    }
    return request<NovaProbeResult>(`/api/probe?url=${encodeURIComponent(url)}`, undefined, 20000);
  },

  async createDownload(payload: CreateDownloadPayload): Promise<DownloadItem> {
    // Generous timeout: the first download may need to start the bundled curl engine.
    return request<DownloadItem>(
      '/api/downloads',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      15000,
    );
  },

  async pauseDownload(id: string): Promise<DownloadItem> {
    return request<DownloadItem>(`/api/downloads/${encodeURIComponent(id)}/pause`, { method: 'POST' }, 3000);
  },

  async resumeDownload(id: string): Promise<DownloadItem> {
    return request<DownloadItem>(`/api/downloads/${encodeURIComponent(id)}/resume`, { method: 'POST' }, 3000);
  },

  async deleteDownload(id: string, deleteFiles = false): Promise<void> {
    const query = deleteFiles ? '?deleteFiles=true' : '';
    await request<unknown>(`/api/downloads/${encodeURIComponent(id)}${query}`, { method: 'DELETE' }, 3000);
  },

  async updateTorrentConfig(config: Record<string, unknown>): Promise<void> {
    await request<unknown>(
      '/api/torrents/config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      },
      5000,
    );
  },

  async probeMedia(url: string): Promise<MediaProbeResult> {
    return request<MediaProbeResult>(`/api/ytdlp/probe?url=${encodeURIComponent(url)}`, undefined, 30000);
  },

  async checkFfmpeg(): Promise<FfmpegStatus> {
    return request<FfmpegStatus>('/api/ytdlp/ffmpeg', undefined, 5000);
  },

  async browserExtensionHealth(): Promise<BrowserExtensionHealth> {
    return request<BrowserExtensionHealth>('/api/browser-extension/health', undefined, 3000);
  },

  async configureBrowserExtension(config: BrowserExtensionConfig): Promise<BrowserExtensionHealth> {
    return request<BrowserExtensionHealth>(
      '/api/browser-extension/config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      },
      3000,
    );
  },

  async probePlaylist(url: string): Promise<MediaPlaylistResult> {
    return request<MediaPlaylistResult>(`/api/ytdlp/probe-playlist?url=${encodeURIComponent(url)}`, undefined, 60000);
  },

  async getTelegramConfig(): Promise<{
    enabled: boolean;
    token: string;
    chatId: number;
    apiBase: string;
    fileUploadLimitMb: number;
  }> {
    return request('/api/telegram/config', undefined, 5000);
  },

  async updateTelegramConfig(config: {
    enabled?: boolean;
    token?: string;
    chatId?: number;
    apiBase?: string;
    fileUploadLimitMb?: number;
  }): Promise<{ ok: boolean }> {
    return request(
      '/api/telegram/config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      },
      5000,
    );
  },

  async testTelegram(): Promise<{ ok: boolean; error?: string }> {
    return request('/api/telegram/test', { method: 'POST' }, 10000);
  },

  async sendTelegramFile(payload: { path: string; caption?: string }): Promise<{ ok: boolean; error?: string }> {
    return request(
      '/api/telegram/send-file',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      120000,
    );
  },

  // ── External Tools ──────────────────────────────────────────────────
  async listExternalTools(): Promise<{
    tools: Array<{
      id: string;
      name: string;
      status: string;
      version?: string;
      path?: string;
      capabilities: Array<{ id: string; name: string; available: boolean }>;
      healthOk: boolean;
      error?: string;
    }>;
  }> {
    return request('/api/external-tools', undefined, 10000);
  },

  async discoverExternalTool(
    toolId: string,
  ): Promise<{ ok: boolean; status: string; version?: string; path?: string }> {
    return request(`/api/external-tools/${toolId}/discover`, { method: 'POST' }, 15000);
  },

  async checkExternalToolHealth(toolId: string): Promise<{ ok: boolean; status: string; error?: string }> {
    return request(`/api/external-tools/${toolId}/health`, { method: 'POST' }, 10000);
  },

  async checkExternalToolUpdates(
    toolId: string,
  ): Promise<{ available: boolean; latestVersion?: string; downloadUrl?: string; releaseNotes?: string }> {
    return request(`/api/external-tools/${toolId}/check-updates`, { method: 'POST' }, 30000);
  },

  async updateExternalTool(toolId: string): Promise<{ ok: boolean; path?: string; status?: string; error?: string }> {
    return request(`/api/external-tools/${toolId}/update`, { method: 'POST' }, 120000);
  },

  async setExternalToolPath(
    toolId: string,
    path: string,
  ): Promise<{ ok: boolean; status?: string; version?: string; path?: string; error?: string }> {
    return request(
      `/api/external-tools/${toolId}/set-path`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      },
      10000,
    );
  },

  async uninstallExternalTool(toolId: string): Promise<{ ok: boolean; error?: string }> {
    return request(`/api/external-tools/${toolId}/uninstall`, { method: 'POST' }, 15000);
  },

  async checkToolCapability(
    capabilityId: string,
  ): Promise<{ capabilityId: string; available: boolean; toolId: string; requiresMessage?: string }> {
    return request(`/api/external-tools/capabilities/${capabilityId}`, undefined, 5000);
  },

  // ── Engine Integration ─────────────────────────────────────────────
  // The daemon exposes a rich engine-control surface (priority queue, bandwidth
  // manager, rate limiting, download profiles, retry policy, download rules,
  // server-side scheduler, mirror failover, plugin system, adaptive/segment
  // telemetry, metadata cache, and aggregate stats). These methods expose every
  // capability the backend supports so the UI can drive the engine directly.

  async getEngineQueue(): Promise<{
    ok: boolean;
    entries: unknown[];
    activeCount: number;
    totalBandwidthKbps: number;
    nextToStart?: string | null;
  }> {
    const data = await request<Record<string, unknown>>('/api/engine/queue', undefined, 5000);
    return {
      ok: Boolean(data.ok),
      entries: Array.isArray(data.entries) ? data.entries : [],
      activeCount: asNum(data.active_count),
      totalBandwidthKbps: asNum(data.total_bandwidth_kbps),
      nextToStart: asStr(data.next_to_start) || null,
    };
  },

  async setQueuePriority(taskId: string, priority: number): Promise<{ ok: boolean; taskId: string; priority: string }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/queue',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, priority }),
      },
      5000,
    );
    return { ok: Boolean(data.ok), taskId: asStr(data.task_id, taskId), priority: asStr(data.priority) };
  },

  async getBandwidth(): Promise<{
    ok: boolean;
    globalLimitKbps: number;
    paused: boolean;
    tasks: Array<{ taskId: string; averageSpeedBps: number; allowedKbps: number }>;
  }> {
    const data = await request<Record<string, unknown>>('/api/engine/bandwidth', undefined, 5000);
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    return {
      ok: Boolean(data.ok),
      globalLimitKbps: asNum(data.global_limit_kbps),
      paused: Boolean(data.paused),
      tasks: tasks.map((t) => {
        const entry = t as Record<string, unknown>;
        return {
          taskId: asStr(entry.task_id),
          averageSpeedBps: asNum(entry.average_speed_bps),
          allowedKbps: asNum(entry.allowed_kbps),
        };
      }),
    };
  },

  async setBandwidth(config: {
    globalLimitKbps?: number;
    paused?: boolean;
    taskLimits?: Record<string, number>;
    removeTaskLimits?: string[];
  }): Promise<{ ok: boolean }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/bandwidth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          global_limit_kbps: config.globalLimitKbps,
          paused: config.paused,
          task_limits: config.taskLimits,
          remove_task_limits: config.removeTaskLimits,
        }),
      },
      5000,
    );
    return { ok: Boolean(data.ok) };
  },

  async getRateLimit(): Promise<{ ok: boolean; paused: boolean; globalLimitKbps: number }> {
    const data = await request<Record<string, unknown>>('/api/engine/rate-limit', undefined, 5000);
    return {
      ok: Boolean(data.ok),
      paused: Boolean(data.paused),
      globalLimitKbps: asNum(data.global_limit_kbps),
    };
  },

  async setRateLimit(config: {
    globalLimitKbps?: number;
    taskLimit?: Record<string, number>;
    removeTaskLimits?: string[];
  }): Promise<{ ok: boolean }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/rate-limit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          global_limit_kbps: config.globalLimitKbps,
          task_limit: config.taskLimit,
          remove_task_limits: config.removeTaskLimits,
        }),
      },
      5000,
    );
    return { ok: Boolean(data.ok) };
  },

  async listProfiles(): Promise<{ ok: boolean; profiles: unknown[]; activeProfile: string }> {
    const data = await request<Record<string, unknown>>('/api/engine/profiles', undefined, 5000);
    return {
      ok: Boolean(data.ok),
      profiles: Array.isArray(data.profiles) ? data.profiles : [],
      activeProfile: asStr(data.active_profile),
    };
  },

  async setActiveProfile(profileId: string): Promise<{ ok: boolean }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/profiles',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId }),
      },
      5000,
    );
    return { ok: Boolean(data.ok) };
  },

  async getProfile(profileId: string): Promise<{ ok: boolean; profile?: unknown }> {
    return request(`/api/engine/profiles/${encodeURIComponent(profileId)}`, undefined, 5000);
  },

  async addCustomProfile(
    manifest: Record<string, unknown>,
  ): Promise<{ ok: boolean; profileId?: string; error?: string }> {
    return request(
      '/api/engine/profiles/custom',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      },
      5000,
    );
  },

  async deleteProfile(profileId: string): Promise<{ ok: boolean }> {
    const data = await request<Record<string, unknown>>(
      `/api/engine/profiles/${encodeURIComponent(profileId)}`,
      { method: 'DELETE' },
      5000,
    );
    return { ok: Boolean(data.ok) };
  },

  async getRetryPolicy(): Promise<{ ok: boolean; policy: unknown; backoffPreviewSecs: number[] }> {
    const data = await request<Record<string, unknown>>('/api/engine/retry-policy', undefined, 5000);
    const preview = Array.isArray(data.backoff_preview_secs) ? data.backoff_preview_secs : [];
    return {
      ok: Boolean(data.ok),
      policy: data.policy,
      backoffPreviewSecs: preview.map((v) => asNum(v)),
    };
  },

  async setRetryPolicy(config: {
    preset?: 'default' | 'aggressive' | 'conservative' | 'none';
    maxRetries?: number;
    baseDelaySecs?: number;
    maxDelaySecs?: number;
    backoffMultiplier?: number;
    jitter?: boolean;
  }): Promise<{ ok: boolean; policy?: unknown; error?: string }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/retry-policy',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preset: config.preset,
          max_retries: config.maxRetries,
          base_delay_secs: config.baseDelaySecs,
          max_delay_secs: config.maxDelaySecs,
          backoff_multiplier: config.backoffMultiplier,
          jitter: config.jitter,
        }),
      },
      5000,
    );
    return { ok: Boolean(data.ok), policy: data.policy, error: asStr(data.error) };
  },

  async listDownloadRules(): Promise<{ ok: boolean; rules: unknown[] }> {
    const data = await request<Record<string, unknown>>('/api/engine/rules', undefined, 5000);
    return { ok: Boolean(data.ok), rules: Array.isArray(data.rules) ? data.rules : [] };
  },

  async addDownloadRule(rule: Record<string, unknown>): Promise<{ ok: boolean; ruleId: string }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/rules',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule }),
      },
      5000,
    );
    return { ok: Boolean(data.ok), ruleId: asStr(data.rule_id) };
  },

  async deleteDownloadRule(ruleId: string): Promise<{ ok: boolean; ruleId: string }> {
    const data = await request<Record<string, unknown>>(
      `/api/engine/rules/${encodeURIComponent(ruleId)}`,
      { method: 'DELETE' },
      5000,
    );
    return { ok: Boolean(data.ok), ruleId: asStr(data.rule_id, ruleId) };
  },

  async listSchedulerRules(): Promise<{ ok: boolean; rules: unknown[]; activeRuleIds: string[] }> {
    const data = await request<Record<string, unknown>>('/api/engine/scheduler', undefined, 5000);
    const active = Array.isArray(data.active_rule_ids) ? data.active_rule_ids : [];
    return {
      ok: Boolean(data.ok),
      rules: Array.isArray(data.rules) ? data.rules : [],
      activeRuleIds: active.map((id) => asStr(id)),
    };
  },

  async addSchedulerRule(rule: Record<string, unknown>): Promise<{ ok: boolean; ruleId: string }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/scheduler',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule }),
      },
      5000,
    );
    return { ok: Boolean(data.ok), ruleId: asStr(data.rule_id) };
  },

  async updateSchedulerRule(rule: Record<string, unknown>): Promise<{ ok: boolean; ruleId: string }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/scheduler/update',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule }),
      },
      5000,
    );
    return { ok: Boolean(data.ok), ruleId: asStr(data.rule_id) };
  },

  async deleteSchedulerRule(ruleId: string): Promise<{ ok: boolean; ruleId: string }> {
    const data = await request<Record<string, unknown>>(
      `/api/engine/scheduler/${encodeURIComponent(ruleId)}`,
      { method: 'DELETE' },
      5000,
    );
    return { ok: Boolean(data.ok), ruleId: asStr(data.rule_id, ruleId) };
  },

  async verifyChecksum(config: { path: string; expected: string; algorithm?: string }): Promise<{
    ok: boolean;
    algorithm?: string;
    expected?: string;
    actual?: string;
    passed?: boolean;
    error?: string;
  }> {
    return request(
      '/api/engine/checksum',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      },
      30000,
    );
  },

  async listMirrors(): Promise<{ ok: boolean; downloads: unknown[] }> {
    const data = await request<Record<string, unknown>>('/api/engine/mirrors', undefined, 5000);
    return { ok: Boolean(data.ok), downloads: Array.isArray(data.downloads) ? data.downloads : [] };
  },

  async addMirror(taskId: string, mirrorUrl: string, priority?: number): Promise<{ ok: boolean; taskId: string }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/mirrors',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, mirror_url: mirrorUrl, priority }),
      },
      5000,
    );
    return { ok: Boolean(data.ok), taskId: asStr(data.task_id, taskId) };
  },

  async setMirror(taskId: string, mirrorUrl: string): Promise<{ ok: boolean; taskId: string; mirrorUrl: string }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/mirrors/set',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, mirror_url: mirrorUrl }),
      },
      5000,
    );
    return {
      ok: Boolean(data.ok),
      taskId: asStr(data.task_id, taskId),
      mirrorUrl: asStr(data.mirror_url, mirrorUrl),
    };
  },

  async triggerMirrorFailover(
    taskId: string,
  ): Promise<{ ok: boolean; taskId: string; activeUrl?: string; error?: string }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/mirrors/failover',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId }),
      },
      5000,
    );
    return {
      ok: Boolean(data.ok),
      taskId: asStr(data.task_id, taskId),
      activeUrl: asStr(data.active_url) || undefined,
      error: asStr(data.error) || undefined,
    };
  },

  async setMirrorFailover(
    taskId: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; taskId: string; failoverEnabled: boolean }> {
    const data = await request<Record<string, unknown>>(
      '/api/engine/mirrors/enable-failover',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, enabled }),
      },
      5000,
    );
    return {
      ok: Boolean(data.ok),
      taskId: asStr(data.task_id, taskId),
      failoverEnabled: Boolean(data.failover_enabled ?? enabled),
    };
  },

  async listPlugins(): Promise<{ ok: boolean; plugins: unknown[]; apiVersion: string }> {
    const data = await request<Record<string, unknown>>('/api/plugins', undefined, 5000);
    return {
      ok: Boolean(data.ok),
      plugins: Array.isArray(data.plugins) ? data.plugins : [],
      apiVersion: asStr(data.api_version),
    };
  },

  async getPlugin(pluginId: string): Promise<{ ok: boolean; plugin?: unknown; error?: string }> {
    const data = await request<Record<string, unknown>>(
      `/api/plugins/${encodeURIComponent(pluginId)}`,
      undefined,
      5000,
    );
    return {
      ok: Boolean(data.ok),
      plugin: data.plugin,
      error: asStr(data.error) || undefined,
    };
  },

  async registerPlugin(manifest: Record<string, unknown>): Promise<{ ok: boolean; pluginId?: string; error?: string }> {
    const data = await request<Record<string, unknown>>(
      '/api/plugins',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest }),
      },
      5000,
    );
    return {
      ok: Boolean(data.ok),
      pluginId: asStr(data.plugin_id) || undefined,
      error: asStr(data.error) || undefined,
    };
  },

  async unregisterPlugin(pluginId: string): Promise<{ ok: boolean; pluginId?: string; error?: string }> {
    const data = await request<Record<string, unknown>>(
      `/api/plugins/${encodeURIComponent(pluginId)}`,
      { method: 'DELETE' },
      5000,
    );
    return {
      ok: Boolean(data.ok),
      pluginId: asStr(data.plugin_id) || undefined,
      error: asStr(data.error) || undefined,
    };
  },

  async enablePlugin(pluginId: string): Promise<{ ok: boolean; pluginId?: string; error?: string }> {
    const data = await request<Record<string, unknown>>(
      `/api/plugins/${encodeURIComponent(pluginId)}/enable`,
      { method: 'POST' },
      5000,
    );
    return {
      ok: Boolean(data.ok),
      pluginId: asStr(data.plugin_id) || undefined,
      error: asStr(data.error) || undefined,
    };
  },

  async disablePlugin(pluginId: string): Promise<{ ok: boolean; pluginId?: string; error?: string }> {
    const data = await request<Record<string, unknown>>(
      `/api/plugins/${encodeURIComponent(pluginId)}/disable`,
      { method: 'POST' },
      5000,
    );
    return {
      ok: Boolean(data.ok),
      pluginId: asStr(data.plugin_id) || undefined,
      error: asStr(data.error) || undefined,
    };
  },

  async updatePluginSettings(
    pluginId: string,
    settings: Record<string, unknown>,
  ): Promise<{ ok: boolean; pluginId?: string; error?: string }> {
    const data = await request<Record<string, unknown>>(
      `/api/plugins/${encodeURIComponent(pluginId)}/settings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      },
      5000,
    );
    return {
      ok: Boolean(data.ok),
      pluginId: asStr(data.plugin_id) || undefined,
      error: asStr(data.error) || undefined,
    };
  },

  async getAdaptiveInfo(taskId: string): Promise<{
    ok: boolean;
    taskId?: string;
    connections?: number;
    maxConnections?: number;
    speed?: number;
    peakSpeed?: number;
    retryState?: { totalRetries: number; lastError: string };
    error?: string;
  }> {
    const data = await request<Record<string, unknown>>(
      `/api/engine/adaptive/${encodeURIComponent(taskId)}`,
      undefined,
      5000,
    );
    const retry = data.retry_state as Record<string, unknown> | undefined;
    return {
      ok: Boolean(data.ok),
      taskId: asStr(data.task_id) || undefined,
      connections: typeof data.connections === 'number' ? data.connections : undefined,
      maxConnections: typeof data.max_connections === 'number' ? data.max_connections : undefined,
      speed: typeof data.speed === 'number' ? data.speed : undefined,
      peakSpeed: typeof data.peak_speed === 'number' ? data.peak_speed : undefined,
      retryState: retry ? { totalRetries: asNum(retry.total_retries), lastError: asStr(retry.last_error) } : undefined,
      error: asStr(data.error) || undefined,
    };
  },

  async getSegmentInfo(taskId: string): Promise<{
    ok: boolean;
    taskId?: string;
    segmented?: boolean;
    totalSegments?: number;
    completedSegments?: number;
    progress?: number;
    error?: string;
  }> {
    const data = await request<Record<string, unknown>>(
      `/api/engine/segments/${encodeURIComponent(taskId)}`,
      undefined,
      5000,
    );
    return {
      ok: Boolean(data.ok),
      taskId: asStr(data.task_id) || undefined,
      segmented: typeof data.segmented === 'boolean' ? data.segmented : undefined,
      totalSegments: typeof data.total_segments === 'number' ? data.total_segments : undefined,
      completedSegments: typeof data.completed_segments === 'number' ? data.completed_segments : undefined,
      progress: typeof data.progress === 'number' ? data.progress : undefined,
      error: asStr(data.error) || undefined,
    };
  },

  async getMetadataCacheStats(): Promise<{ ok: boolean; entries: number }> {
    const data = await request<Record<string, unknown>>('/api/engine/cache', undefined, 5000);
    return { ok: Boolean(data.ok), entries: asNum(data.entries) };
  },

  async clearMetadataCache(): Promise<{ ok: boolean }> {
    const data = await request<Record<string, unknown>>('/api/engine/cache', { method: 'DELETE' }, 5000);
    return { ok: Boolean(data.ok) };
  },

  async getStats(): Promise<{
    totalCompleted: number;
    totalFailed: number;
    totalDownloadedBytes: number;
    activeDownloads: number;
    sessionStartedAt?: string;
  }> {
    return request('/api/stats', undefined, 5000);
  },

  async getPendingCaptures(): Promise<{ ok: boolean; captures?: unknown[] }> {
    return request('/captures/pending', undefined, 5000);
  },
};

async function request<T>(path: string, init?: RequestInit, timeoutMs = 2500): Promise<T> {
  const doFetch = async (abortSignal?: AbortSignal): Promise<T> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let combinedSignal: AbortSignal = controller.signal;
    let detachExternalAbort: (() => void) | null = null;
    if (abortSignal) {
      const combined = combineAbortSignals(controller.signal, abortSignal);
      combinedSignal = combined.signal;
      detachExternalAbort = combined.cleanup;
    }

    try {
      const headers = new Headers(init?.headers);
      if (_authToken) headers.set('Authorization', `Bearer ${_authToken}`);
      const response = await fetch(`${getApiBase()}${path}`, {
        ...init,
        headers,
        signal: combinedSignal,
      });

      if (!response.ok) {
        let message = `NOVA daemon request failed with HTTP ${String(response.status)}`;
        try {
          const payload = (await response.json()) as { error?: string } | null;
          if (payload?.error) message = payload.error;
        } catch (parseErr) {
          console.warn('NovaClient: could not parse error body', parseErr);
        }
        throw new Error(message);
      }

      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    } finally {
      window.clearTimeout(timer);
      detachExternalAbort?.();
    }
  };

  const retryController = new AbortController();

  try {
    return await doFetch(retryController.signal);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('HTTP 4')) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        retryController.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (retryController.signal.aborted) throw err;
      return await doFetch(retryController.signal);
    }
    throw err;
  } finally {
    // Ensure any pending wait/abort listeners are released promptly.
    retryController.abort();
  }
}

interface CombinedAbortSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

function combineAbortSignals(...signals: AbortSignal[]): CombinedAbortSignal {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      for (const cleanup of cleanups) cleanup();
      return { signal: controller.signal, cleanup: () => {} };
    }
    const onAbort = () => {
      controller.abort(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => {
      signal.removeEventListener('abort', onAbort);
    });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}
