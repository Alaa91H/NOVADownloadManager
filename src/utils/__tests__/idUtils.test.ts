import { describe, it, expect, vi, afterAll } from 'vitest';
import { createLocalId } from '../idUtils';

describe('createLocalId', () => {
  const originalCrypto = globalThis.crypto;

  afterAll(() => {
    Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, writable: true, configurable: true });
  });

  it('returns string starting with given prefix', () => {
    const id = createLocalId('task');
    expect(id).toContain('task-');
    expect(typeof id).toBe('string');
  });

  it('uses crypto.randomUUID when available', () => {
    const fakeUuid = '550e8400-e29b-41d4-a716-446655440000';
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => fakeUuid },
      writable: true,
      configurable: true,
    });
    const id = createLocalId('dl');
    expect(id).toBe('dl-550e8400-e29b-41d4-a716-446655440000');
  });

  it('falls back to Date.now when crypto.randomUUID unavailable', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      writable: true,
      configurable: true,
    });
    const now = 1234567890000;
    vi.setSystemTime(now);
    const id = createLocalId('q');
    expect(id).toBe('q-1234567890000');
    vi.useRealTimers();
  });

  it('generates unique IDs on successive calls', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: originalCrypto,
      writable: true,
      configurable: true,
    });
    const id1 = createLocalId('task');
    const id2 = createLocalId('task');
    expect(id1).not.toBe(id2);
  });
});
