import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const extensionId = 'testextid';
  const browser = {
    runtime: {
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getURL: (path: string) => `chrome-extension://${extensionId}/${String(path).replace(/^\//, '')}`,
      getManifest: () => ({ name: 'NOVA Extension', version: '0.0.0', manifest_version: 3 }),
      // Native host unavailable: every native invocation rejects.
      sendNativeMessage: () => Promise.reject(new Error('native host missing')),
    },
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: store.get(key) }),
        set: (entries: Record<string, unknown>) => { for (const [k, v] of Object.entries(entries)) store.set(k, v); return Promise.resolve(); },
        remove: (keys: string | string[]) => { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); return Promise.resolve(); },
      },
    },
  };
  return { browser, store };
});

vi.mock('webextension-polyfill', () => ({ default: harness.browser }));

import { BridgeManager } from '../../bridge/bridge-manager';
import { BridgeState, initialBridgeState } from '../../core/app-state';

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports connected when loopback HTTP is reachable even if Native Messaging is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
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

        if (url.endsWith('/v1/pair/auto')) {
          return Promise.resolve(
            jsonResponse({
              ok: true,
              pairToken: 'test-pair-token-1234567890',
              autoApproved: true,
              protocolVersion: 4,
              minimumSupportedProtocolVersion: 4,
              ttlSeconds: 3600,
            }),
          );
        }

        if (url.endsWith('/v1/extension-settings')) {
          return Promise.resolve(
            jsonResponse({
              ok: true,
              capabilities: {
                items: ['candidate.directUrl', 'task.add', 'task.addBatch'],
                directProtocols: ['http', 'https'],
                engineCapabilities: {
                  directReady: true,
                  mediaReady: false,
                  allReady: false,
                },
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse({ ok: false, error: 'unexpected route' }, 404));
      }),
    );

    const bridge = new BridgeManager(fakeStateStore() as never);
    const state = await bridge.autoConnect();
    expect(state.status).toBe('connected');
    expect(state.canSend).toBe(true);
    expect(state.transport).toBe('http');
  });
});
