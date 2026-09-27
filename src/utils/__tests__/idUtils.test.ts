import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLocalId } from '../idUtils';

describe('createLocalId', () => {
  it('uses randomUUID when available', () => {
    const uuid = '12345678-1234-1234-1234-123456789012';
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => uuid) });
    expect(createLocalId('task')).toBe(`task-${uuid}`);
  });

  it('falls back to Date.now() when randomUUID is missing', () => {
    vi.stubGlobal('crypto', {});
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(createLocalId('task')).toBe(`task-${String(now)}`);
  });

  it('falls back to Date.now() when crypto is undefined', () => {
    vi.stubGlobal('crypto', undefined);
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(createLocalId('job')).toBe(`job-${String(now)}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
