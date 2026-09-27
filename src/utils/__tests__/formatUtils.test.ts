import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatBytes,
  formatSpeed,
  formatTimeLeft,
  isMagnetLink,
  formatElapsed,
  extractErrorMessage,
} from '../formatUtils';

describe('formatBytes', () => {
  it('formats bytes into human-readable units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    expect(formatBytes(1024 ** 4)).toBe('1 TB');
  });

  it('handles non-finite input', () => {
    expect(formatBytes(Number.NaN)).toBe('Unknown');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('Unknown');
    expect(formatBytes(Number.NEGATIVE_INFINITY)).toBe('Unknown');
  });

  it('normalizes trailing zeros', () => {
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(1024 * 1024 * 10)).toBe('10 MB');
  });
});

describe('formatSpeed', () => {
  it('returns -- for zero or non-finite speeds', () => {
    expect(formatSpeed(0)).toBe('--');
    expect(formatSpeed(-5)).toBe('--');
    expect(formatSpeed(Number.NaN)).toBe('--');
    expect(formatSpeed(Number.POSITIVE_INFINITY)).toBe('--');
  });

  it('formats positive speeds with one decimal', () => {
    expect(formatSpeed(500)).toBe('500 B/s');
    expect(formatSpeed(1024)).toBe('1 KB/s');
    expect(formatSpeed(1024 * 1024)).toBe('1 MB/s');
    expect(formatSpeed(1024 ** 3)).toBe('1 GB/s');
    expect(formatSpeed(1536)).toBe('1.5 KB/s');
  });
});

describe('formatTimeLeft', () => {
  it('returns -- for zero or non-finite seconds', () => {
    expect(formatTimeLeft(0)).toBe('--');
    expect(formatTimeLeft(-10)).toBe('--');
    expect(formatTimeLeft(Number.NaN)).toBe('--');
  });

  it('formats seconds under a minute', () => {
    expect(formatTimeLeft(59)).toBe('59s');
  });

  it('formats minutes and seconds', () => {
    expect(formatTimeLeft(60)).toBe('1m 0s');
    expect(formatTimeLeft(125)).toBe('2m 5s');
  });

  it('formats hours and minutes', () => {
    expect(formatTimeLeft(3600)).toBe('1h 0m');
    expect(formatTimeLeft(3725)).toBe('1h 2m');
  });
});

describe('isMagnetLink', () => {
  it('detects magnet links ignoring whitespace', () => {
    expect(isMagnetLink('magnet:?xt=urn:btih:abc')).toBe(true);
    expect(isMagnetLink('  magnet:?xt=urn:btih:abc  ')).toBe(true);
    expect(isMagnetLink('https://example.com/file')).toBe(false);
    expect(isMagnetLink('')).toBe(false);
  });
});

describe('formatElapsed', () => {
  it('returns 0s for non-finite or negative input', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(-5)).toBe('0s');
    expect(formatElapsed(Number.NaN)).toBe('0s');
  });

  it('formats seconds, minutes and hours', () => {
    expect(formatElapsed(7)).toBe('7s');
    expect(formatElapsed(65)).toBe('1m 05s');
    expect(formatElapsed(3661)).toBe('1h 01m 01s');
  });
});

describe('extractErrorMessage', () => {
  it('extracts the message from Error instances', () => {
    expect(extractErrorMessage(new Error('boom'), 'fallback')).toBe('boom');
  });

  it('passes through strings', () => {
    expect(extractErrorMessage('plain error', 'fallback')).toBe('plain error');
  });

  it('uses the fallback for anything else', () => {
    expect(extractErrorMessage(null, 'fallback')).toBe('fallback');
    expect(extractErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(extractErrorMessage({ code: 42 }, 'fallback')).toBe('fallback');
    expect(extractErrorMessage(42, 'fallback')).toBe('fallback');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
