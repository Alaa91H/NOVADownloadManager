import { describe, it, expect, afterEach } from 'vitest';
import { detachedMode, isDetachedWindow, detachedTaskId } from '../windowMode';

const setSearch = (search: string) => {
  Object.defineProperty(window, 'location', {
    value: { search },
    writable: true,
    configurable: true,
  });
};

afterEach(() => {
  setSearch('');
});

describe('detachedMode', () => {
  it('returns null for the primary window', () => {
    setSearch('');
    expect(detachedMode()).toBeNull();
  });

  it('returns progress for a detached progress window', () => {
    setSearch('?detached=progress&taskId=t1');
    expect(detachedMode()).toBe('progress');
  });

  it('returns null for unknown detached modes', () => {
    setSearch('?detached=other');
    expect(detachedMode()).toBeNull();
  });
});

describe('isDetachedWindow', () => {
  it('is false for the primary window', () => {
    setSearch('');
    expect(isDetachedWindow()).toBe(false);
  });

  it('is true for a detached window', () => {
    setSearch('?detached=progress');
    expect(isDetachedWindow()).toBe(true);
  });
});

describe('detachedTaskId', () => {
  it('returns the task id when present', () => {
    setSearch('?detached=progress&taskId=abc-123');
    expect(detachedTaskId()).toBe('abc-123');
  });

  it('returns null when absent', () => {
    setSearch('?detached=progress');
    expect(detachedTaskId()).toBeNull();
  });
});
