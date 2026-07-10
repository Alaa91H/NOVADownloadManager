import { DownloadItem } from '../types/desktop-ui.types';
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

let _apiBase: string | undefined;

async function resolveApiBase(): Promise<string> {
  if (_apiBase !== undefined) return _apiBase;
  const envUrl = import.meta.env.VITE_NOVA_API_URL as string | undefined;
  if (envUrl) {
    _apiBase = envUrl.replace(/\/$/, '');
    return _apiBase;
  }
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const url = await invoke<string>('get_daemon_url');
      _apiBase = url.replace(/\/$/, '');
      return _apiBase;
    } catch {
      _apiBase = 'http://127.0.0.1:3199';
      return _apiBase;
    }
  }
  _apiBase = '';
  return _apiBase;
}

function getApiBase(): string {
  if (_apiBase !== undefined) return _apiBase;
  const envUrl = import.meta.env.VITE_NOVA_API_URL as string | undefined;
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

  async diagnostics(): Promise<DiagnosticData> {
    return request<DiagnosticData>('/api/diagnostics', undefined, 15000);
  },

  async listDownloads(): Promise<DownloadItem[]> {
    return request<DownloadItem[]>('/api/downloads', undefined, 2000);
  },

  streamDownloads(onDownloads: (downloads: DownloadItem[]) => void, onError?: (event: Event) => void): () => void {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
      return () => {};
    }

    const source = new EventSource(`${getApiBase()}/api/downloads/events`);
    const handleDownloads = (event: MessageEvent<string>) => {
      try {
        onDownloads(JSON.parse(event.data) as DownloadItem[]);
      } catch (parseErr) {
        console.warn('NovaClient: could not parse download event', parseErr);
      }
    };

    source.addEventListener('downloads', handleDownloads as EventListener);
    source.onerror = (event) => {
      onError?.(event);
    };

    return () => {
      source.removeEventListener('downloads', handleDownloads as EventListener);
      source.close();
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

  async addTorrent(payload: {
    torrentBase64?: string;
    magnet?: string;
    name?: string;
    savePath?: string;
    startImmediately?: boolean;
  }): Promise<DownloadItem> {
    return request<DownloadItem>(
      '/api/torrents',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      15000,
    );
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
};

async function request<T>(path: string, init?: RequestInit, timeoutMs = 2500): Promise<T> {
  const doFetch = async (abortSignal?: AbortSignal): Promise<T> => {
    const controller = new AbortController();
    const combinedSignal = abortSignal ? combineAbortSignals(controller.signal, abortSignal) : controller.signal;
    const timer = window.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(`${getApiBase()}${path}`, {
        ...init,
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
    }
  };

  const retrySignal = new AbortController();

  try {
    return await doFetch(retrySignal.signal);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('HTTP 4')) {
      await new Promise<void>((r) => {
        const timer = setTimeout(r, 500);
        retrySignal.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          r();
        });
      });
      if (retrySignal.signal.aborted) throw err;
      return doFetch(retrySignal.signal);
    }
    throw err;
  }
}

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      'abort',
      () => {
        controller.abort(signal.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}
