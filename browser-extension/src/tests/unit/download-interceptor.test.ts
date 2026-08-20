import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../contracts/settings.schema';

type DownloadCreatedListener = (item: {
  id?: number;
  url?: string;
  filename?: string;
  totalBytes?: number;
  tabId?: number;
}) => void;

const harness = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const createdListeners: DownloadCreatedListener[] = [];
  const changedListeners: Array<(delta: unknown) => void> = [];
  const sendCandidate = vi.fn();
  const cancel = vi.fn(() => Promise.resolve());
  const download = vi.fn(() => Promise.resolve(9001));
  const sendMessage = vi.fn(() => Promise.resolve(undefined));

  const storageLocal = {
    get: (key: string | string[] | null) => {
      if (key === null) return Promise.resolve(Object.fromEntries(store));
      if (Array.isArray(key)) {
        return Promise.resolve(Object.fromEntries(key.map((item) => [item, store.get(item)])));
      }
      return Promise.resolve({ [key]: store.get(key) });
    },
    set: (entries: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries)) store.set(key, value);
      return Promise.resolve();
    },
    remove: (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      return Promise.resolve();
    },
  };

  return {
    browser: {
      downloads: {
        onCreated: { addListener: (listener: DownloadCreatedListener) => createdListeners.push(listener) },
        onChanged: { addListener: (listener: (delta: unknown) => void) => changedListeners.push(listener) },
        cancel,
        download,
        erase: vi.fn(() => Promise.resolve()),
      },
      storage: { local: storageLocal },
      tabs: { sendMessage },
    },
    cancel,
    download,
    changedListeners,
    createdListeners,
    sendCandidate,
    sendMessage,
    store,
  };
});

vi.mock('webextension-polyfill', () => ({ default: harness.browser }));
vi.mock('../../bridge/bridge-manager', () => ({
  bridgeManager: {
    sendCandidate: harness.sendCandidate,
    getState: () => ({ canSend: false }),
    autoConnect: () => Promise.resolve({ canSend: false }),
    wakeUpDesktop: () => Promise.resolve({ canSend: false }),
  },
}));

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe('download interceptor takeover', () => {
  beforeEach(() => {
    vi.resetModules();
    harness.store.clear();
    harness.createdListeners.length = 0;
    harness.changedListeners.length = 0;
    harness.cancel.mockClear();
    harness.download.mockClear();
    harness.sendMessage.mockClear();
    harness.sendCandidate.mockReset();
    harness.sendCandidate.mockResolvedValue({ status: 'sent' });
    harness.store.set('nova.siteRules', []);
    harness.store.set('nova.settings', {
      ...defaultSettings,
      enabled: true,
      capture: {
        ...defaultSettings.capture,
        downloads: true,
        aggressiveMode: true,
        takeoverEnabled: true,
        takeoverMinSizeMB: 0,
        takeoverFileTypes: [],
        neverTakeoverHosts: [],
        alwaysTakeoverHosts: [],
      },
    });
  });

  it('hands off and cancels browser downloads even without an auto-send rule', async () => {
    const { registerDownloadInterceptor } = await import('../../background/download-interceptor');
    registerDownloadInterceptor();

    expect(harness.createdListeners).toHaveLength(1);
    harness.createdListeners[0]?.({
      id: 77,
      url: 'https://example.com/file.zip',
      filename: 'file.zip',
      totalBytes: 1024,
      tabId: 1,
    });

    await waitFor(() => expect(harness.sendCandidate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(harness.cancel).toHaveBeenCalledWith(77));
  }, 15_000);

  it('allows the one-shot browser restart when takeover policy declines after cancellation', async () => {
    harness.store.set('nova.settings', {
      ...defaultSettings,
      enabled: true,
      capture: {
        ...defaultSettings.capture,
        downloads: true,
        aggressiveMode: false,
        takeoverEnabled: true,
        takeoverMinSizeMB: 100,
        takeoverFileTypes: [],
        neverTakeoverHosts: [],
        alwaysTakeoverHosts: [],
      },
    });
    const { registerDownloadInterceptor } = await import('../../background/download-interceptor');
    registerDownloadInterceptor();

    const original = {
      id: 91,
      url: 'https://example.com/small.zip',
      filename: 'small.zip',
      totalBytes: 1024,
      tabId: 1,
    };
    harness.createdListeners[0]?.(original);
    await waitFor(() => expect(harness.cancel).toHaveBeenCalledWith(91));
    await waitFor(() => expect(harness.download).toHaveBeenCalledWith(expect.objectContaining({ url: original.url })));

    harness.createdListeners[0]?.({ ...original, id: 92 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.cancel).not.toHaveBeenCalledWith(92);
    expect(harness.download).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('does not hand off when download capture and aggressive mode are disabled', async () => {
    harness.store.set('nova.settings', {
      ...defaultSettings,
      enabled: true,
      capture: {
        ...defaultSettings.capture,
        downloads: false,
        aggressiveMode: false,
        takeoverEnabled: false,
      },
    });
    const { registerDownloadInterceptor } = await import('../../background/download-interceptor');
    registerDownloadInterceptor();

    const original = {
      id: 103,
      url: 'https://example.com/user-owned-download.zip',
      filename: 'user-owned-download.zip',
      totalBytes: 2048,
      tabId: 1,
    };
    harness.createdListeners[0]?.(original);

    await waitFor(() => expect(harness.cancel).toHaveBeenCalledWith(103));
    await waitFor(() => expect(harness.download).toHaveBeenCalledWith(expect.objectContaining({ url: original.url })));
    expect(harness.sendCandidate).not.toHaveBeenCalled();
  }, 15_000);

  it('rejects a manual content-script capture when download capture is disabled', async () => {
    harness.store.set('nova.settings', {
      ...defaultSettings,
      enabled: true,
      capture: {
        ...defaultSettings.capture,
        downloads: false,
        aggressiveMode: false,
        takeoverEnabled: false,
      },
    });
    const { handleManualCapture } = await import('../../background/download-interceptor');

    await handleManualCapture({
      url: 'https://example.com/disabled-content-capture.zip',
      filename: 'disabled-content-capture.zip',
      source: 'download-attribute',
    });

    expect(harness.sendCandidate).not.toHaveBeenCalled();
  });

  it('cancels immediately even when the desktop bridge is offline', async () => {
    harness.sendCandidate.mockRejectedValueOnce(new Error('offline'));
    const { registerDownloadInterceptor } = await import('../../background/download-interceptor');
    registerDownloadInterceptor();

    harness.createdListeners[0]?.({
      id: 88,
      url: 'https://cdn.example.com/big.iso',
      filename: 'big.iso',
      totalBytes: 50_000_000,
      tabId: 2,
    });

    await waitFor(() => expect(harness.cancel).toHaveBeenCalledWith(88));
  }, 15_000);
});
