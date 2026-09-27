import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const extensionId = 'testextid';
  let nativePairResponse: unknown = null;
  const browser = {
    runtime: {
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getURL: (path: string) => `chrome-extension://${extensionId}/${String(path).replace(/^\//, '')}`,
      getManifest: () => ({ name: 'NOVA Extension', version: '0.0.0', manifest_version: 3 }),
      // Native host is unavailable by default; individual tests can supply a
      // validated pair response to prove the secure native-first handshake.
      sendNativeMessage: () => nativePairResponse
        ? Promise.resolve(nativePairResponse)
        : Promise.reject(new Error('native host missing')),
    },
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: store.get(key) }),
        set: (entries: Record<string, unknown>) => { for (const [k, v] of Object.entries(entries)) store.set(k, v); return Promise.resolve(); },
        remove: (keys: string | string[]) => { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); return Promise.resolve(); },
      },
    },
  };
  return {
    browser,
    store,
    setNativePairResponse: (response: unknown) => {
      nativePairResponse = response;
    },
  };
});

vi.mock('webextension-polyfill', () => ({ default: harness.browser }));

import { assertTaskAccepted, BridgeManager } from '../../bridge/bridge-manager';
import { type BridgeState, initialBridgeState } from '../../core/app-state';

function fakeStateStore() {
  let state: BridgeState = initialBridgeState;
  return {
    getBridgeState: () => Promise.resolve(state),
    setBridgeState: (next: BridgeState) => { state = next; return Promise.resolve(); },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BridgeManager task acceptance', () => {
  it('rejects a daemon response that did not create any task', () => {
    expect(() => assertTaskAccepted({ ok: false, accepted: false, message: 'invalid URL' })).toThrow('invalid URL');
    expect(() => assertTaskAccepted({ ok: true, accepted: true, taskIds: [] })).toThrow('NOVA rejected the download task.');
  });

  it('preserves an accepted daemon response with created tasks', () => {
    expect(assertTaskAccepted({ ok: true, accepted: true, taskId: 'task-1', taskIds: ['task-1'] })).toMatchObject({ taskId: 'task-1' });
  });
});

describe('BridgeManager (daemon unreachable)', () => {
  beforeEach(() => {
    harness.store.clear();
    // Loopback HTTP is unreachable: every fetch rejects like a refused connection.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports offline with a DAEMON_UNAVAILABLE error when neither native nor HTTP is reachable', async () => {
    const bridge = new BridgeManager(fakeStateStore() as never);
    const state = await bridge.autoConnect();
    expect(state.status).toBe('offline');
    expect(state.canSend).toBe(false);
    expect(state.lastError?.code).toBe('DAEMON_UNAVAILABLE');
    expect(state.lastError?.retryable).toBe(true);
  });

  it('keeps getState() in sync with the last computed state', async () => {
    const bridge = new BridgeManager(fakeStateStore() as never);
    await bridge.autoConnect();
    expect(bridge.getState().status).toBe('offline');
  });

  it('returns an empty task list while the bridge cannot send', async () => {
    const bridge = new BridgeManager(fakeStateStore() as never);
    await bridge.autoConnect();
    await expect(bridge.listTasks()).resolves.toEqual([]);
  });

  it('does not get stuck in a sending state after a failed connect', async () => {
    const bridge = new BridgeManager(fakeStateStore() as never);
    await bridge.autoConnect();
    await bridge.autoConnect();
    expect(bridge.getState().canSend).toBe(false);
    expect(bridge.getState().status).toBe('offline');
  });
});

describe('BridgeManager (loopback HTTP reachable)', () => {
  beforeEach(() => {
    harness.store.clear();
    harness.setNativePairResponse(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not pair from loopback HTTP alone when Native Messaging is missing', async () => {
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/ping')) {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            app: 'NOVA Download Manager',
            appVersion: '0.1.0',
            protocolVersion: 4,
            minimumSupportedProtocolVersion: 4,
            browserIntegrationEnabled: true,
          }),
        );
      }

      return Promise.resolve(jsonResponse({ ok: false, error: 'unexpected route' }, 404));
    });
    vi.stubGlobal('fetch', fetchMock);

    const bridge = new BridgeManager(fakeStateStore() as never);
    const state = await bridge.autoConnect();

    expect(state.status).toBe('offline');
    expect(state.canSend).toBe(false);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContainEqual(
      expect.stringContaining('/v1/pair/auto'),
    );
  });

  it('prefers Native Messaging for pairing when the trusted host is available', async () => {
    harness.setNativePairResponse({
      id: 'native-pair',
      ok: true,
      result: {
        ok: true,
        pairToken: 'native-pair-token-1234567890',
        autoApproved: true,
        method: 'native-messaging-verified',
        protocolVersion: 4,
        minimumSupportedProtocolVersion: 4,
        ttlSeconds: 3600,
      },
    });
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/ping')) {
        return Promise.resolve(jsonResponse({
          ok: true,
          app: 'NOVA Download Manager',
          appVersion: '0.1.0',
          protocolVersion: 4,
          minimumSupportedProtocolVersion: 4,
          browserIntegrationEnabled: true,
        }));
      }
      if (url.endsWith('/v1/extension-settings')) {
        return Promise.resolve(jsonResponse({ ok: true, capabilities: { items: [] } }));
      }
      return Promise.resolve(jsonResponse({ ok: false, error: 'pairing should use Native Messaging' }, 500));
    });
    vi.stubGlobal('fetch', fetchMock);

    const bridge = new BridgeManager(fakeStateStore() as never);
    const state = await bridge.autoConnect();

    expect(state.status).toBe('connected');
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContainEqual(
      expect.stringContaining('/v1/pair/auto'),
    );
  });
});


describe('BridgeManager (SSE recovery)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-subscribes after an immediate SSE error while the bridge remains send-ready', async () => {
    vi.useFakeTimers();
    const bridge = new BridgeManager(fakeStateStore() as never);
    (bridge as unknown as { state: BridgeState }).state = { ...initialBridgeState, status: 'connected', canSend: true };
    const subscribe = vi.spyOn(bridge, 'subscribeEvents').mockImplementation(() => {});

    (bridge as unknown as { scheduleEventResubscribe(): void }).scheduleEventResubscribe();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
