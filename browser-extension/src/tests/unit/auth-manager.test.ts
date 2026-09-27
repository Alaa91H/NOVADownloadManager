import { afterEach, describe, expect, it, vi } from 'vitest';

const mockStorage = new Map<string, unknown>();

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: mockStorage.get(key) }),
        set: (entries: Record<string, unknown>) => { for (const [k, v] of Object.entries(entries)) mockStorage.set(k, v); return Promise.resolve(); },
        remove: (keys: string | string[]) => { for (const k of Array.isArray(keys) ? keys : [keys]) mockStorage.delete(k); return Promise.resolve(); },
      },
    },
  },
}));

import { AuthManager } from '../../bridge/auth-manager';

describe('AuthManager', () => {
  afterEach(() => mockStorage.clear());

  it('returns undefined when no token stored', async () => {
    const auth = new AuthManager();
    await expect(auth.getToken()).resolves.toBeUndefined();
  });

  it('stores and retrieves a token', async () => {
    const auth = new AuthManager();
    await auth.setToken('tok-1234567890abcdef12345678');
    await expect(auth.getToken()).resolves.toBe('tok-1234567890abcdef12345678');
  });

  it('stores token with TTL', async () => {
    const auth = new AuthManager();
    await auth.setToken('tok-with-ttl-1234567890abcdef', 3600);
    const status = await auth.tokenStatus();
    expect(status.present).toBe(true);
    expect(status.expiresAt).toBeDefined();
  });

  it('reports token status correctly', async () => {
    const auth = new AuthManager();
    let status = await auth.tokenStatus();
    expect(status.present).toBe(false);

    await auth.setToken('tok-1234567890abcdef12345678');
    status = await auth.tokenStatus();
    expect(status.present).toBe(true);
  });

  it('clears token', async () => {
    const auth = new AuthManager();
    await auth.setToken('tok-1234567890abcdef12345678');
    await auth.clear();
    await expect(auth.getToken()).resolves.toBeUndefined();
  });
});
