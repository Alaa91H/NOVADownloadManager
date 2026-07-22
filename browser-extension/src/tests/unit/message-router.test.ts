import { describe, expect, it, vi } from 'vitest';

// Shared mock handle, created before the hoisted vi.mock factory runs.
const harness = vi.hoisted(() => {
  // Late import to avoid pulling test-only helper types into the factory scope.
  let listener: ((msg: unknown, sender: unknown) => unknown) | undefined;
  const store = new Map<string, unknown>();
  const extensionId = 'testextid';
  const openOptionsPage = vi.fn(() => Promise.resolve());
  const createTab = vi.fn(() => Promise.resolve({ id: 1 }));
  const browser = {
    runtime: {
      onMessage: { addListener: (fn: (msg: unknown, sender: unknown) => unknown) => { listener = fn; } },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getURL: (path: string) => `chrome-extension://${extensionId}/${String(path).replace(/^\//, '')}`,
      getManifest: () => ({ name: 'NOVA Extension', version: '0.0.0', manifest_version: 3 }),
      openOptionsPage,
      sendNativeMessage: () => Promise.reject(new Error('native host missing')),
    },
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: store.get(key) }),
        set: (entries: Record<string, unknown>) => { for (const [k, v] of Object.entries(entries)) store.set(k, v); return Promise.resolve(); },
        remove: (keys: string | string[]) => { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); return Promise.resolve(); },
      },
    },
    tabs: { create: createTab, query: () => Promise.resolve([{ id: 1, active: true }]), sendMessage: () => Promise.resolve(undefined) },
    scripting: {
      executeScript: () => Promise.resolve([{ result: { url: 'https://example.com/watch', baseUrl: 'https://example.com/watch', title: 'watch', html: '', links: [], media: [], openGraph: [], jsonLd: [], capturedAt: new Date().toISOString() } }]),
    },
    action: { setBadgeText: () => Promise.resolve(), setTitle: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    permissions: { contains: () => Promise.resolve(true) },
  };
  return {
    browser,
    createTab,
    extensionId,
    invoke: (msg: unknown, sender: unknown) => {
      if (!listener) throw new Error('no listener registered');
      return Promise.resolve(listener(msg, sender));
    },
    uiSender: { url: `chrome-extension://${extensionId}/popup.html` },
    pageSender: { url: 'https://example.com/watch', tab: { id: 42 } },
    openOptionsPage,
  };
});

vi.mock('webextension-polyfill', () => ({ default: harness.browser }));

// Importing the router registers the onMessage listener via the mocked browser.
import '../../background/message-router';

describe('message-router dispatch + policy', () => {
  it('rejects messages that fail schema validation', async () => {
    const response = (await harness.invoke({ type: 'NOT_A_REAL_MESSAGE' }, harness.uiSender)) as { ok: boolean; code: string };
    expect(response.ok).toBe(false);
    expect(response.code).toBe('VALIDATION_FAILED');
  });

  it('rejects UI-only messages from a page/content-script sender', async () => {
    const response = (await harness.invoke({ type: 'SCAN_PAGE', userActivated: true }, harness.pageSender)) as { ok: boolean; code: string };
    expect(response.ok).toBe(false);
    expect(response.code).toBe('PERMISSION_MISSING');
  });

  it('rejects a send-batch from an untrusted sender before reaching the bridge', async () => {
    const response = (await harness.invoke(
      { type: 'SEND_BATCH', candidates: [{ id: 'c1', url: 'https://example.com/a.zip', source: 'dom', mediaType: 'archive', confidence: 75, createdAt: '2026-01-01T00:00:00.000Z' }] },
      harness.pageSender,
    )) as { ok: boolean; code: string };
    expect(response.ok).toBe(false);
    expect(response.code).toBe('PERMISSION_MISSING');
  });

  it('allows the passive GET_BRIDGE_STATE read from any sender and returns bridge state', async () => {
    const state = (await harness.invoke({ type: 'GET_BRIDGE_STATE' }, harness.pageSender)) as { status: string; canSend: boolean };
    expect(typeof state.status).toBe('string');
    expect(typeof state.canSend).toBe('boolean');
  });

  it('rejects SCAN_PAGE from a content-script sender even when userActivated is claimed', async () => {
    const response = (await harness.invoke({ type: 'SCAN_PAGE', userActivated: true }, harness.pageSender)) as { ok: boolean; code: string };
    expect(response.ok).toBe(false);
    expect(response.code).toBe('PERMISSION_MISSING');
  });

  it('passes policy for OVERLAY_SCAN_PAGE from a trusted content script but reports the overlay as disabled', async () => {
    const response = (await harness.invoke({ type: 'OVERLAY_SCAN_PAGE' }, harness.pageSender)) as { ok?: boolean; code?: string; error?: string };
    // The sender policy must accept the trusted content script (no
    // PERMISSION_MISSING), while the feature itself is intentionally
    // disabled — captures are managed from the popup.
    expect(response.code).not.toBe('PERMISSION_MISSING');
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/disabled/i);
  });

  it('rejects OVERLAY_SCAN_PAGE when the sender has no originating tab id', async () => {
    const response = (await harness.invoke({ type: 'OVERLAY_SCAN_PAGE' }, { url: 'https://example.com/no-tab' })) as { ok: boolean; code: string };
    expect(response.ok).toBe(false);
    expect(response.code).toBe('PERMISSION_MISSING');
  });

  it('keeps OVERLAY_SCAN_PAGE disabled responses stable across repeated calls', async () => {
    const sender = { url: 'https://example.com/rate', tab: { id: 77 } };
    for (let i = 0; i < 13; i += 1) {
      const response = (await harness.invoke({ type: 'OVERLAY_SCAN_PAGE' }, sender)) as { ok: boolean; error?: string };
      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/disabled/i);
    }
  });

  it('returns LIST_TASKS as a { ok, tasks } envelope, never a bare array', async () => {
    const response = (await harness.invoke({ type: 'LIST_TASKS' }, harness.uiSender)) as { ok?: boolean; tasks?: unknown[] };
    expect(Array.isArray(response)).toBe(false);
    expect(response.ok).toBe(true);
    expect(Array.isArray(response.tasks)).toBe(true);
  });

  it('rejects OVERLAY_SEND_SELECTED when the sender has no originating tab id', async () => {
    const response = (await harness.invoke({ type: 'OVERLAY_SEND_SELECTED', candidateIds: ['c1'] }, { url: 'https://example.com/no-tab' })) as { ok: boolean; code: string };
    expect(response.ok).toBe(false);
    expect(response.code).toBe('PERMISSION_MISSING');
  });

  it('rejects OVERLAY_SEND_SELECTED from an extension UI sender (content-script-only message)', async () => {
    const response = (await harness.invoke({ type: 'OVERLAY_SEND_SELECTED', candidateIds: ['c1'] }, harness.uiSender)) as { ok: boolean; code: string };
    expect(response.ok).toBe(false);
    expect(response.code).toBe('PERMISSION_MISSING');
  });

  it('reports OVERLAY_SEND_SELECTED as disabled for a trusted content-script sender', async () => {
    const response = (await harness.invoke({ type: 'OVERLAY_SEND_SELECTED', candidateIds: ['does-not-exist'] }, harness.pageSender)) as { ok: boolean; code?: string; error?: string };
    expect(response.code).not.toBe('PERMISSION_MISSING');
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/disabled/i);
  });
});
