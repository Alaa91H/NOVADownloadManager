import { DownloadItem } from '../types/desktop-ui.types';
import type { DiagnosticData } from './tauriClient';

export interface NovaHealth {
  status: 'connected' | 'degraded';
  name: string;
  version: string;
  pid: number;
  engines: {
    aria2: {
      available: boolean;
      version: string;
      rpcReady: boolean;
      rpcPort: number;
      error?: string;
    };
    ytdlp: {
      available: boolean;
      version: string;
      error?: string;
    };
  };
}

export interface NovaProbeResult {
  url: string;
  fileName: string;
  fileType: DownloadItem['fileType'];
  sizeBytes: number;
  resumable: boolean;
  contentType: string;
}

export interface YtDlpFormat {
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

export interface YtDlpProbeResult {
  id: string;
  title: string;
  duration: number;
  durationString: string;
  thumbnail: string;
  webpageUrl: string;
  formats: YtDlpFormat[];
}

export interface FfmpegStatus {
  available: boolean;
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
}

export interface YtDlpPlaylistEntry {
  id: string;
  title: string;
  url: string;
  duration: number;
  durationString: string;
  thumbnail: string;
  index: number;
}

export interface YtDlpPlaylistResult {
  title: string;
  webpageUrl: string;
  entries: YtDlpPlaylistEntry[];
}

type CreateDownloadPayload = Omit<
  DownloadItem,
  'id' | 'dateAdded' | 'downloadedBytes' | 'speedBytesPerSec' | 'timeLeftSeconds' | 'segments'
> & {
  startImmediately: boolean;
};

let _apiBase: string | undefined;

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

  async diagnostics(): Promise<DiagnosticData> {
    return request<DiagnosticData>('/api/diagnostics', undefined, 2000);
  },

  async listDownloads(): Promise<DownloadItem[]> {
    return request<DownloadItem[]>('/api/downloads', undefined, 2000);
  },

  async probeDownload(url: string): Promise<NovaProbeResult> {
    return request<NovaProbeResult>(`/api/probe?url=${encodeURIComponent(url)}`, undefined, 5000);
  },

  async createDownload(payload: CreateDownloadPayload): Promise<DownloadItem> {
    // Generous timeout: the first download may need to cold-start aria2.
    return request<DownloadItem>('/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 15000);
  },

  async pauseDownload(id: string): Promise<DownloadItem> {
    return request<DownloadItem>(`/api/downloads/${encodeURIComponent(id)}/pause`, { method: 'POST' }, 3000);
  },

  async resumeDownload(id: string): Promise<DownloadItem> {
    return request<DownloadItem>(`/api/downloads/${encodeURIComponent(id)}/resume`, { method: 'POST' }, 3000);
  },

  async deleteDownload(id: string): Promise<void> {
    await request<unknown>(`/api/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' }, 3000);
  },

  async addTorrent(payload: { torrentBase64?: string; magnet?: string; name?: string; savePath?: string }): Promise<DownloadItem> {
    return request<DownloadItem>('/api/torrents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 15000);
  },

  async updateTorrentConfig(config: Record<string, unknown>): Promise<void> {
    await request<unknown>('/api/torrents/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    }, 5000);
  },

  async probeMedia(url: string): Promise<YtDlpProbeResult> {
    return request<YtDlpProbeResult>(`/api/ytdlp/probe?url=${encodeURIComponent(url)}`, undefined, 30000);
  },

  async checkFfmpeg(): Promise<FfmpegStatus> {
    return request<FfmpegStatus>('/api/ytdlp/ffmpeg', undefined, 5000);
  },

  async browserExtensionHealth(): Promise<BrowserExtensionHealth> {
    return request<BrowserExtensionHealth>('/api/browser-extension/health', undefined, 3000);
  },

  async configureBrowserExtension(config: BrowserExtensionConfig): Promise<BrowserExtensionHealth> {
    return request<BrowserExtensionHealth>('/api/browser-extension/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    }, 3000);
  },

  async probePlaylist(url: string): Promise<YtDlpPlaylistResult> {
    return request<YtDlpPlaylistResult>(`/api/ytdlp/probe-playlist?url=${encodeURIComponent(url)}`, undefined, 60000);
  },

  async getTelegramConfig(): Promise<{ enabled: boolean; token: string; chatId: number }> {
    return request('/api/telegram/config', undefined, 5000);
  },

  async updateTelegramConfig(config: { enabled?: boolean; token?: string; chatId?: number }): Promise<{ ok: boolean }> {
    return request('/api/telegram/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    }, 5000);
  },

  async testTelegram(): Promise<{ ok: boolean; error?: string }> {
    return request('/api/telegram/test', { method: 'POST' }, 10000);
  }
};

async function request<T>(path: string, init?: RequestInit, timeoutMs = 2500): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${getApiBase()}${path}`, {
      ...init,
      signal: controller.signal
    });

    if (!response.ok) {
      let message = `NOVA daemon request failed with HTTP ${response.status}`;
      try {
        const payload = await response.json();
        if (payload?.error) message = payload.error;
      } catch {
        // Keep the generic HTTP message.
      }
      throw new Error(message);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return await response.json() as T;
  } finally {
    window.clearTimeout(timer);
  }
}
