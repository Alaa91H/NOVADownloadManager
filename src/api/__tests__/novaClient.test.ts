import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { novaClient, setApiBase } from '../novaClient';

const BASE = 'http://127.0.0.1:3199';

function mockFetch(response: Partial<Response>) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({}),
    status: 200,
    ...response,
  });
}

function mockFetchOnce(response: Partial<Response>) {
  globalThis.fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({}),
    status: 200,
    ...response,
  });
}

describe('setApiBase', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('strips trailing slash', () => {
    setApiBase('http://localhost:3199/');
    mockFetch({ json: () => Promise.resolve({}) });
    novaClient.health();
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3199/api/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('overrides the default base URL', () => {
    setApiBase('http://localhost:9999');
    mockFetch({ json: () => Promise.resolve({}) });
    novaClient.health();
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:9999/api/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe('novaClient.health', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('builds correct URL', async () => {
    mockFetch({
      json: () => Promise.resolve({ status: 'connected', engines: { curl: {}, ytdlp: {} } }),
    });
    const result = await novaClient.health();
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/health`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.status).toBe('connected');
  });
});

describe('novaClient.engineCapabilities', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('fetches engine capabilities', async () => {
    const caps = { curl: { available: true }, ytdlp: { available: false } };
    mockFetch({ json: () => Promise.resolve(caps) });
    const result = await novaClient.engineCapabilities();
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/engines/capabilities`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual(caps);
  });
});

describe('novaClient.diagnostics', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('fetches diagnostics data', async () => {
    const diag = { system: { memory: 1024 }, engines: {} };
    mockFetch({ json: () => Promise.resolve(diag) });
    const result = await novaClient.diagnostics();
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/diagnostics`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual(diag);
  });
});

describe('novaClient.listDownloads', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('lists all downloads', async () => {
    const downloads = [{ id: '1', name: 'Test' }];
    mockFetch({ json: () => Promise.resolve(downloads) });
    const result = await novaClient.listDownloads();
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/downloads`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });
});

describe('novaClient.streamDownloads', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('returns a noop cleanup when EventSource is unavailable', () => {
    const origEventSource = globalThis.EventSource;
    (globalThis as any).EventSource = undefined;

    const cleanup = novaClient.streamDownloads(vi.fn());
    expect(typeof cleanup).toBe('function');
    cleanup();

    globalThis.EventSource = origEventSource;
  });

  it('creates an EventSource and returns cleanup', () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const close = vi.fn();

    (globalThis as any).EventSource = vi.fn().mockImplementation(function (this: any, _url: string) {
      this.addEventListener = addEventListener;
      this.removeEventListener = removeEventListener;
      this.close = close;
    });

    const onDownloads = vi.fn();
    const cleanup = novaClient.streamDownloads(onDownloads);

    expect(EventSource).toHaveBeenCalledWith(`${BASE}/api/downloads/events`);
    expect(addEventListener).toHaveBeenCalledWith('downloads', expect.any(Function));

    cleanup();
    expect(removeEventListener).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();

    (globalThis as any).EventSource = undefined;
  });
});

describe('novaClient.probeDownload', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('sends GET request without payload', async () => {
    const probeResult = { url: 'https://example.com/file.zip', fileName: 'file.zip', sizeBytes: 1000 };
    mockFetch({ json: () => Promise.resolve(probeResult) });
    const result = await novaClient.probeDownload('https://example.com/file.zip');
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/probe?url=${encodeURIComponent('https://example.com/file.zip')}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.fileName).toBe('file.zip');
  });

  it('sends POST request with payload', async () => {
    const probeResult = { url: 'https://example.com/video.mp4', fileName: 'video.mp4', sizeBytes: 5000 };
    mockFetch({ json: () => Promise.resolve(probeResult) });
    const result = await novaClient.probeDownload('https://example.com/video.mp4', { fileType: 'video' });
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/probe`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.any(String),
        signal: expect.any(AbortSignal),
      }),
    );
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.url).toBe('https://example.com/video.mp4');
    expect(body.fileType).toBe('video');
    expect(result.fileName).toBe('video.mp4');
  });
});

describe('novaClient.createDownload', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('creates a download via POST', async () => {
    const created = { id: 'new-1', name: 'My Download', url: 'https://example.com/file.zip', status: 'queued' };
    mockFetch({ json: () => Promise.resolve(created) });
    const payload = {
      name: 'My Download',
      url: 'https://example.com/file.zip',
      fileType: 'other' as const,
      engine: 'curl' as const,
      queueId: 'main',
      status: 'queued' as const,
      startImmediately: false,
      sizeBytes: 0,
      category: 'other' as const,
      connections: 1,
      resumable: true,
      savePath: '',
      description: '',
      referer: undefined,
    };
    const result = await novaClient.createDownload(payload);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/downloads`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
    expect(result.id).toBe('new-1');
  });
});

describe('novaClient.pauseDownload', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('pauses a download via POST', async () => {
    const paused = { id: 'dl-1', status: 'paused' };
    mockFetch({ json: () => Promise.resolve(paused) });
    const result = await novaClient.pauseDownload('dl-1');
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/downloads/dl-1/pause`,
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(result.status).toBe('paused');
  });

  it('encodes the download ID', async () => {
    mockFetch({ json: () => Promise.resolve({}) });
    await novaClient.pauseDownload('dl with spaces');
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/downloads/${encodeURIComponent('dl with spaces')}/pause`,
      expect.anything(),
    );
  });
});

describe('novaClient.resumeDownload', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('resumes a download via POST', async () => {
    const resumed = { id: 'dl-1', status: 'downloading' };
    mockFetch({ json: () => Promise.resolve(resumed) });
    const result = await novaClient.resumeDownload('dl-1');
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/downloads/dl-1/resume`,
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(result.status).toBe('downloading');
  });
});

describe('novaClient.deleteDownload', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('deletes a download via DELETE', async () => {
    mockFetch({ status: 204, json: () => Promise.resolve(undefined) });
    await novaClient.deleteDownload('dl-1');
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/downloads/dl-1`,
      expect.objectContaining({ method: 'DELETE', signal: expect.any(AbortSignal) }),
    );
  });

  it('appends deleteFiles query parameter', async () => {
    mockFetch({ status: 204, json: () => Promise.resolve(undefined) });
    await novaClient.deleteDownload('dl-1', true);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/downloads/dl-1?deleteFiles=true`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('novaClient.addTorrent', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('sends torrent data via POST', async () => {
    const result = { id: 'torrent-1', name: 'Torrent' };
    mockFetch({ json: () => Promise.resolve(result) });
    const response = await novaClient.addTorrent({ torrentBase64: 'dGVzdA==', name: 'Torrent' });
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/torrents`,
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(response.id).toBe('torrent-1');
  });

  it('sends magnet link via POST', async () => {
    mockFetch({ json: () => Promise.resolve({}) });
    await novaClient.addTorrent({ magnet: 'magnet:?xt=urn:btih:abc123' });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.magnet).toBe('magnet:?xt=urn:btih:abc123');
  });
});

describe('novaClient.updateTorrentConfig', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('sends config via POST', async () => {
    mockFetch({ status: 204, json: () => Promise.resolve(undefined) });
    await novaClient.updateTorrentConfig({ maxActiveDownloads: 5 });
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/torrents/config`,
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
  });
});

describe('novaClient.probeMedia', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('probes media URL', async () => {
    const probe = { id: 'abc123', title: 'Test Video', duration: 120, formats: [] };
    mockFetch({ json: () => Promise.resolve(probe) });
    const result = await novaClient.probeMedia('https://youtube.com/watch?v=abc123');
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/ytdlp/probe?url=${encodeURIComponent('https://youtube.com/watch?v=abc123')}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.title).toBe('Test Video');
  });
});

describe('novaClient.checkFfmpeg', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('checks ffmpeg status', async () => {
    const status = { available: true, version: '4.4' };
    mockFetch({ json: () => Promise.resolve(status) });
    const result = await novaClient.checkFfmpeg();
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/ytdlp/ffmpeg`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.available).toBe(true);
  });
});

describe('novaClient.browserExtensionHealth', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('checks browser extension health', async () => {
    const health = { status: 'ok', enabled: true, paired: true, version: '1.0' };
    mockFetch({ json: () => Promise.resolve(health) });
    const result = await novaClient.browserExtensionHealth();
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/browser-extension/health`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.paired).toBe(true);
  });
});

describe('novaClient.configureBrowserExtension', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('sends config via POST', async () => {
    const config = { enabled: true, token: 'abc', minSizeMb: 10, defaultFolder: '/downloads', categoryFolders: {}, userAgent: '' };
    const response = { status: 'ok', enabled: true, paired: false, version: '1.0', captureEndpoint: '', directDownloads: true, mediaDownloads: true };
    mockFetch({ json: () => Promise.resolve(response) });
    const result = await novaClient.configureBrowserExtension(config);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/browser-extension/config`,
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(result.status).toBe('ok');
  });
});

describe('novaClient.probePlaylist', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('probes playlist URL', async () => {
    const playlist = { title: 'Playlist', webpageUrl: 'https://youtube.com/playlist?list=abc', entries: [] };
    mockFetch({ json: () => Promise.resolve(playlist) });
    const result = await novaClient.probePlaylist('https://youtube.com/playlist?list=abc');
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/ytdlp/probe-playlist?url=${encodeURIComponent('https://youtube.com/playlist?list=abc')}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.title).toBe('Playlist');
  });
});

describe('novaClient.telegram', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('getTelegramConfig fetches config', async () => {
    const config = { enabled: false, token: '', chatId: 0, apiBase: '', fileUploadLimitMb: 50 };
    mockFetch({ json: () => Promise.resolve(config) });
    const result = await novaClient.getTelegramConfig();
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/telegram/config`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.fileUploadLimitMb).toBe(50);
  });

  it('updateTelegramConfig sends config', async () => {
    mockFetch({ json: () => Promise.resolve({ ok: true }) });
    const result = await novaClient.updateTelegramConfig({ enabled: true });
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/telegram/config`,
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(result.ok).toBe(true);
  });

  it('testTelegram sends test', async () => {
    mockFetch({ json: () => Promise.resolve({ ok: true }) });
    const result = await novaClient.testTelegram();
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/telegram/test`,
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(result.ok).toBe(true);
  });

  it('sendTelegramFile sends file', async () => {
    mockFetch({ json: () => Promise.resolve({ ok: true }) });
    const result = await novaClient.sendTelegramFile({ path: '/tmp/file.zip', caption: 'Done' });
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/telegram/send-file`,
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('novaClient error handling', () => {
  beforeEach(() => {
    setApiBase(BASE);
  });

  it('throws on HTTP 400 error with message from body', async () => {
    mockFetch({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Invalid download URL' }),
    });
    await expect(novaClient.listDownloads()).rejects.toThrow('Invalid download URL');
  });

  it('throws generic HTTP error when body has no error field', async () => {
    mockFetch({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    await expect(novaClient.listDownloads()).rejects.toThrow('HTTP 500');
  });

  it('throws generic HTTP error when json parsing fails', async () => {
    mockFetch({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('parse error')),
    });
    await expect(novaClient.listDownloads()).rejects.toThrow('HTTP 502');
  });

  it('handles network errors with retry', async () => {
    vi.useFakeTimers();

    const networkError = new Error('Network error');
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'connected' }),
        status: 200,
      });

    const healthPromise = novaClient.health();
    await vi.advanceTimersByTimeAsync(500);
    const result = await healthPromise;

    expect(result.status).toBe('connected');
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('retries up to twice on transient errors', async () => {
    vi.useFakeTimers();

    const networkError = new Error('Network error');
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'connected' }),
        status: 200,
      });

    const healthPromise = novaClient.health();
    await vi.advanceTimersByTimeAsync(500);
    const result = await healthPromise;

    expect(result).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('does not retry on HTTP 4xx errors', async () => {
    mockFetch({
      ok: false,
      status: 400,
      json: () => Promise.resolve({}),
    });

    await expect(novaClient.listDownloads()).rejects.toThrow('HTTP 400');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('handles 204 No Content response', async () => {
    mockFetch({ status: 204, json: () => Promise.reject(new Error('should not be called')) });
    const result = await novaClient.deleteDownload('dl-1');
    expect(result).toBeUndefined();
  });
});
