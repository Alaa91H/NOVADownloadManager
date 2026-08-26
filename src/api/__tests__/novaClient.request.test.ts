import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { novaClient, setApiBase, setAuthToken } from '../novaClient';
import type { DownloadItem } from '../../types/desktop-ui.types';

// A minimal EventSource stub that lets tests dispatch events deterministically.
class EventSourceStub {
  static instances: EventSourceStub[] = [];
  url: string;
  listeners = new Map<string, EventListener[]>();
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    EventSourceStub.instances.push(this);
  }

  addEventListener(type: string, cb: EventListener) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, cb: EventListener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l !== cb),
    );
  }

  dispatch(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    const list = this.listeners.get(type) ?? [];
    list.forEach((cb) => {
      cb(event);
    });
  }

  close() {
    this.closed = true;
  }
}

function makeTask(id: string, name = id): DownloadItem {
  return {
    id,
    name,
    url: `http://example.com/${id}`,
    fileName: name,
    fileType: 'other',
    status: 'downloading',
    sizeBytes: 1000,
    downloadedBytes: 0,
    speedBytesPerSec: 0,
    timeLeftSeconds: 0,
    dateAdded: new Date(0).toISOString(),
    segments: [],
    savePath: '',
    priority: 0,
    retries: 0,
    isMedia: false,
    elapsedSeconds: 0,
    category: 'other',
    queueId: 'main',
    connections: 1,
    completedBytes: 0,
    error: null,
    resumable: true,
    description: '',
  } as DownloadItem;
}

describe('novaClient request (REPAIR 0.3)', () => {
  beforeEach(() => {
    setApiBase('http://127.0.0.1:3199');
    setAuthToken('');
    EventSourceStub.instances = [];
    vi.stubGlobal('EventSource', EventSourceStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retries idempotent GET once after a transient network error', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'connected' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await novaClient.health();
    expect(result).toEqual({ status: 'connected' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-idempotent methods', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(novaClient.pauseDownload('1')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry HTTP 4xx errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'not found' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(novaClient.health()).rejects.toThrow('not found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws a descriptive error from the daemon error body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'engine exploded' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(novaClient.health()).rejects.toThrow('engine exploded');
  });

  it('sends the bearer token when set', async () => {
    setAuthToken('sekrit');
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: 'connected' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await novaClient.health();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3199/api/health');
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer sekrit');
  });

  it('aborts the request when the timeout fires', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const promise = novaClient.health().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(8100);
    const err = await promise;
    expect(err).toBeTruthy();
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain('Aborted');
    vi.useRealTimers();
  });

  it('works without window (non-browser environment)', async () => {
    // Phase 7: request() must not touch `window` — it should work in Node,
    // workers, or any non-browser host.
    const windowRef = globalThis.window;
    delete (globalThis as Record<string, unknown>).window;
    try {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'connected' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const result = await novaClient.health();
      expect(result).toEqual({ status: 'connected' });
    } finally {
      (globalThis as Record<string, unknown>).window = windowRef;
    }
  });
});

describe('novaClient streamDownloads delta merge (REPAIR 0.3)', () => {
  beforeEach(() => {
    setApiBase('http://127.0.0.1:3199');
    setAuthToken('');
    EventSourceStub.instances = [];
    vi.stubGlobal('EventSource', EventSourceStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function latest(): EventSourceStub {
    const instances = EventSourceStub.instances;
    return instances[instances.length - 1] ?? new EventSourceStub('http://missing');
  }

  it('applies delta changes and removals onto the current list', () => {
    const onDownloads = vi.fn();
    novaClient.streamDownloads(onDownloads);

    const source = latest();
    // Initial full sync: tasks a, b
    source.dispatch('downloads', [makeTask('a'), makeTask('b')]);
    expect(onDownloads).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'a' }),
      expect.objectContaining({ id: 'b' }),
    ]);
    expect(onDownloads).toHaveBeenCalledTimes(1);

    // Delta: change b, remove a, add c
    source.dispatch('downloads-delta', {
      changed: [makeTask('b', 'b-updated'), makeTask('c')],
      removed: ['a'],
    });
    const calls = onDownloads.mock.calls;
    const last = (calls[calls.length - 1] as DownloadItem[][])[0];
    const ids = last.map((t) => t.id);
    expect(ids).toEqual(['b', 'c']);
    expect(last.find((t) => t.id === 'b')?.name).toBe('b-updated');
  });

  it('cleanup closes the EventSource and stops health polling', () => {
    const stop = novaClient.streamDownloads(vi.fn());
    const source = latest();
    expect(source.closed).toBe(false);

    stop();
    expect(source.closed).toBe(true);
    // Subsequent events must be ignored.
    expect(() => {
      source.dispatch('downloads', [makeTask('x')]);
    }).not.toThrow();
  });

  it('uses a token query parameter on the SSE URL', () => {
    setAuthToken('tok123');
    novaClient.streamDownloads(vi.fn());
    expect(latest().url).toContain('/api/downloads/events?token=tok123');
  });

  it('keeps an idle SSE connection open while the daemon sends keep-alive comments', async () => {
    vi.useFakeTimers();
    const stop = novaClient.streamDownloads(vi.fn());
    const source = latest();
    source.onopen?.(new Event('open'));

    // Keep-alive comments are intentionally not exposed as MessageEvents by
    // EventSource. An idle task list must not therefore be treated as a broken
    // stream and reconnected every 10–20 seconds.
    await vi.advanceTimersByTimeAsync(30000);
    expect(EventSourceStub.instances).toHaveLength(1);
    expect(source.closed).toBe(false);

    stop();
    vi.useRealTimers();
  });

  it('notifies consumers whenever the SSE stream opens or reconnects', async () => {
    vi.useFakeTimers();
    const onConnected = vi.fn();
    const stop = novaClient.streamDownloads(vi.fn(), undefined, onConnected);
    const first = latest();

    first.onopen?.(new Event('open'));
    expect(onConnected).toHaveBeenCalledTimes(1);
    first.onerror?.(new Event('error'));
    await vi.advanceTimersByTimeAsync(500);
    latest().onopen?.(new Event('open'));
    expect(onConnected).toHaveBeenCalledTimes(2);

    stop();
    vi.useRealTimers();
  });

  it('schedules only one reconnect after an actual SSE error', async () => {
    vi.useFakeTimers();
    const stop = novaClient.streamDownloads(vi.fn());
    const source = latest();

    source.onerror?.(new Event('error'));
    source.onerror?.(new Event('error'));
    expect(source.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(EventSourceStub.instances).toHaveLength(2);

    stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(EventSourceStub.instances).toHaveLength(2);
    vi.useRealTimers();
  });
});
