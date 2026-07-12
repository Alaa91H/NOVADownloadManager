async function engineRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiBase();
  const mergedHeaders = new Headers(init?.headers);
  mergedHeaders.set('Content-Type', 'application/json');
  const response = await fetch(`${base}${path}`, { ...init, headers: mergedHeaders });
  if (!response.ok) {
    let message = `Engine request failed: ${String(response.status)}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* ignore parse errors */ }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function getApiBase(): string {
  const envUrl = import.meta.env.VITE_NOVA_API_URL as string | undefined;
  if (envUrl) return envUrl.replace(/\/$/, '');
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) return 'http://127.0.0.1:3199';
  return '';
}

export interface EngineEvent {
  id: number;
  event: Record<string, unknown>;
  timestamp_millis: number;
}

export interface QueueEntry {
  task_id: string;
  priority: string;
  position: number;
  allocated_kbps: number;
  size_bytes: number;
}

export interface PluginInfo {
  manifest: {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    api_version: string;
    hooks: string[];
    settings: Record<string, unknown>;
  };
  state: {
    id: string;
    enabled: boolean;
    settings: Record<string, unknown>;
    error: string | null;
  };
}

export interface ChecksumResult {
  ok: boolean;
  algorithm?: string;
  expected?: string;
  actual?: string;
  passed?: boolean;
  error?: string;
}

export interface SchedulerRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Record<string, unknown>;
  action: Record<string, unknown>;
}

export interface DownloadRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: Array<Record<string, unknown>>;
  action: Record<string, unknown>;
}

export interface DownloadProfile {
  id: string;
  name: string;
  description: string;
  default_connections: number;
  max_connections: number;
  adaptive: boolean;
}

export const engineApi = {
  getEvents: (count = 100) =>
    engineRequest<{ ok: boolean; events: EngineEvent[] }>(`/api/engine/events?count=${String(count)}`),

  getTaskEvents: (taskId: string, count = 50) =>
    engineRequest<{ ok: boolean; events: EngineEvent[] }>(`/api/engine/events/${taskId}?count=${String(count)}`),

  getQueue: () =>
    engineRequest<{ ok: boolean; entries: QueueEntry[]; active_count: number; total_bandwidth_kbps: number }>('/api/engine/queue'),

  setPriority: (taskId: string, priority: number) =>
    engineRequest<{ ok: boolean }>('/api/engine/queue', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, priority }),
    }),

  getBandwidth: () =>
    engineRequest<{ ok: boolean; global_limit_kbps: number; paused: boolean }>('/api/engine/bandwidth'),

  setBandwidth: (limitKbps?: number, paused?: boolean) =>
    engineRequest<{ ok: boolean }>('/api/engine/bandwidth', {
      method: 'POST',
      body: JSON.stringify({ global_limit_kbps: limitKbps, paused }),
    }),

  getRateLimit: () =>
    engineRequest<{ ok: boolean; paused: boolean }>('/api/engine/rate-limit'),

  setRateLimit: (limitKbps?: number, taskLimits?: Record<string, number>) =>
    engineRequest<{ ok: boolean }>('/api/engine/rate-limit', {
      method: 'POST',
      body: JSON.stringify({ global_limit_kbps: limitKbps, task_limit: taskLimits }),
    }),

  getProfiles: () =>
    engineRequest<{ ok: boolean; profiles: DownloadProfile[]; active_profile: string }>('/api/engine/profiles'),

  setActiveProfile: (profileId: string) =>
    engineRequest<{ ok: boolean }>('/api/engine/profiles', {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId }),
    }),

  getRules: () =>
    engineRequest<{ ok: boolean; rules: DownloadRule[] }>('/api/engine/rules'),

  addRule: (rule: DownloadRule) =>
    engineRequest<{ ok: boolean; rule_id: string }>('/api/engine/rules', {
      method: 'POST',
      body: JSON.stringify({ rule }),
    }),

  deleteRule: (ruleId: string) =>
    engineRequest<{ ok: boolean }>(`/api/engine/rules/${ruleId}`, { method: 'DELETE' }),

  getScheduler: () =>
    engineRequest<{ ok: boolean; rules: SchedulerRule[] }>('/api/engine/scheduler'),

  addSchedulerRule: (rule: SchedulerRule) =>
    engineRequest<{ ok: boolean; rule_id: string }>('/api/engine/scheduler', {
      method: 'POST',
      body: JSON.stringify({ rule }),
    }),

  deleteSchedulerRule: (ruleId: string) =>
    engineRequest<{ ok: boolean }>(`/api/engine/scheduler/${ruleId}`, { method: 'DELETE' }),

  verifyChecksum: (filePath: string, expected: string, algorithm?: string) =>
    engineRequest<ChecksumResult>('/api/engine/checksum', {
      method: 'POST',
      body: JSON.stringify({ path: filePath, expected, algorithm }),
    }),

  getPlugins: () =>
    engineRequest<{ ok: boolean; plugins: PluginInfo[]; api_version: string }>('/api/plugins'),

  getPlugin: (pluginId: string) =>
    engineRequest<{ ok: boolean; plugin: PluginInfo }>(`/api/plugins/${pluginId}`),

  registerPlugin: (manifest: PluginInfo['manifest']) =>
    engineRequest<{ ok: boolean; plugin_id: string }>('/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ manifest }),
    }),

  unregisterPlugin: (pluginId: string) =>
    engineRequest<{ ok: boolean }>(`/api/plugins/${pluginId}`, { method: 'DELETE' }),

  enablePlugin: (pluginId: string) =>
    engineRequest<{ ok: boolean }>(`/api/plugins/${pluginId}/enable`, { method: 'POST' }),

  disablePlugin: (pluginId: string) =>
    engineRequest<{ ok: boolean }>(`/api/plugins/${pluginId}/disable`, { method: 'POST' }),

  updatePluginSettings: (pluginId: string, settings: Record<string, unknown>) =>
    engineRequest<{ ok: boolean }>(`/api/plugins/${pluginId}/settings`, {
      method: 'POST',
      body: JSON.stringify({ settings }),
    }),
};
