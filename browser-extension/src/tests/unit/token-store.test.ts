import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStore } from '../../storage/token-store';

const store = new Map<string, unknown>();

function fakeBrowser() {
  return {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: store.get(key) }),
        set: (entries: Record<string, unknown>) => { for (const [k, v] of Object.entries(entries)) store.set(k, v); return Promise.resolve(); },
        remove: (keys: string | string[]) => { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); return Promise.resolve(); },
      },
    },
  };
}

vi.mock('webextension-polyfill', () => ({ default: fakeBrowser() }));

beforeEach(() => store.clear());
afterEach(() => store.clear());

describe('TokenStore', () => {
  it('returns undefined when no token is stored', async () => {
    const ts = new TokenStore();
    await expect(ts.get()).resolves.toBeUndefined();
  });

  it('stores and retrieves a token', async () => {
    const ts = new TokenStore();
    await ts.set('valid-token-value-that-is-at-least-24-chars');
    await expect(ts.get()).resolves.toBe('valid-token-value-that-is-at-least-24-chars');
  });

  it('returns undefined for a short legacy token (< 24 chars) and clears it', async () => {
    store.set('adm.pairToken', 'short');
    const ts = new TokenStore();
    await expect(ts.get()).resolves.toBeUndefined();
    expect(store.has('adm.pairToken')).toBe(false);
  });

  it('reads a legacy string token', async () => {
    store.set('adm.pairToken', 'legacy-token-value-exactly-over-twenty-four');
    const ts = new TokenStore();
    await expect(ts.get()).resolves.toBe('legacy-token-value-exactly-over-twenty-four');
  });

  it('returns undefined for expired token and clears it', async () => {
    const ts = new TokenStore();
    await ts.set('still-another-valid-token-len-ok', 0);
    await expect(ts.get()).resolves.toBeUndefined();
    expect(store.has('adm.pairToken')).toBe(false);
  });

  it('clears token when storage has invalid format', async () => {
    store.set('adm.pairToken', 42);
    const ts = new TokenStore();
    await expect(ts.get()).resolves.toBeUndefined();
    expect(store.has('adm.pairToken')).toBe(false);
  });

  it('status() returns none for missing token', async () => {
    const s = await new TokenStore().status();
    expect(s.present).toBe(false);
    expect(s.storageFormat).toBe('none');
  });

  it('status() returns legacy-string for string tokens', async () => {
    store.set('adm.pairToken', 'a-string-that-is-more-than-twenty-four');
    const s = await new TokenStore().status();
    expect(s.present).toBe(true);
    expect(s.storageFormat).toBe('legacy-string');
  });

  it('status() returns invalid for garbage data', async () => {
    store.set('adm.pairToken', [1, 2, 3]);
    const s = await new TokenStore().status();
    expect(s.present).toBe(false);
    expect(s.storageFormat).toBe('invalid');
  });

  it('status() returns record format and expiry info', async () => {
    const ts = new TokenStore();
    await ts.set('valid-token-over-twenty-four-chars', 3600);
    const s = await ts.status();
    expect(s.present).toBe(true);
    expect(s.storageFormat).toBe('record');
    expect(s.expired).toBe(false);
    expect(s.expiresAt).toBeDefined();
  });

  it('clear() removes the token', async () => {
    const ts = new TokenStore();
    await ts.set('a-valid-token-that-meets-twenty-four-min');
    await ts.clear();
    await expect(ts.get()).resolves.toBeUndefined();
  });

  it('set with no ttl produces no expiresAt', async () => {
    const ts = new TokenStore();
    await ts.set('valid-token-value-abc12345-length');
    const s = await ts.status();
    expect(s.expiresAt).toBeUndefined();
  });
});
