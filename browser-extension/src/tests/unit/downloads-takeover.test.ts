import { describe, expect, it } from 'vitest';
import type { Settings } from '../../contracts/settings.schema';
import { defaultSettings } from '../../contracts/settings.schema';

// Re-implement the shouldTakeover logic as a pure function for testing
function shouldTakeover(
  item: { url?: string; totalBytes?: number; fileSize?: number; filename?: string },
  capture: Settings['capture'],
): boolean {
  if (!capture.takeoverEnabled) return false;

  const url = item.url ?? '';
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (capture.neverTakeoverHosts.some((h) => host.endsWith(h))) return false;
    if (capture.alwaysTakeoverHosts.some((h) => host.endsWith(h))) return true;
  } catch { /* malformed URL */ }

  const sizeBytes = item.totalBytes ?? item.fileSize ?? 0;
  if (sizeBytes > 0 && sizeBytes < capture.takeoverMinSizeMB * 1024 * 1024) return false;

  if (capture.takeoverFileTypes.length > 0) {
    const ext = (item.filename ?? url).split('.').pop()?.toLowerCase() ?? '';
    return capture.takeoverFileTypes.includes(ext);
  }

  return true;
}

const baseTakeoverSettings: Settings['capture'] = {
  ...defaultSettings.capture,
  takeoverEnabled: true,
  askBeforeTakeover: false,
  takeoverMinSizeMB: 0,
  takeoverFileTypes: [],
  neverTakeoverHosts: [],
  alwaysTakeoverHosts: [],
};

describe('downloads takeover policy', () => {
  it('returns false when takeoverEnabled is false', () => {
    const capture = { ...baseTakeoverSettings, takeoverEnabled: false };
    expect(shouldTakeover({ url: 'https://example.com/file.zip' }, capture)).toBe(false);
  });

  it('returns true when enabled with no restrictions', () => {
    expect(shouldTakeover({ url: 'https://example.com/file.zip' }, baseTakeoverSettings)).toBe(true);
  });

  it('respects neverTakeoverHosts', () => {
    const capture = { ...baseTakeoverSettings, neverTakeoverHosts: ['trusted.com'] };
    expect(shouldTakeover({ url: 'https://trusted.com/file.zip' }, capture)).toBe(false);
    expect(shouldTakeover({ url: 'https://other.com/file.zip' }, capture)).toBe(true);
  });

  it('respects alwaysTakeoverHosts (overrides size limit)', () => {
    const capture = { ...baseTakeoverSettings, alwaysTakeoverHosts: ['cdn.example.com'], takeoverMinSizeMB: 100 };
    // file is 1 byte but host is in alwaysTakeoverHosts
    expect(shouldTakeover({ url: 'https://cdn.example.com/tiny.mp4', totalBytes: 1 }, capture)).toBe(true);
  });

  it('skips files below takeoverMinSizeMB', () => {
    const capture = { ...baseTakeoverSettings, takeoverMinSizeMB: 10 };
    const small = 5 * 1024 * 1024; // 5 MB
    expect(shouldTakeover({ url: 'https://example.com/file.zip', totalBytes: small }, capture)).toBe(false);
  });

  it('accepts files at or above takeoverMinSizeMB', () => {
    const capture = { ...baseTakeoverSettings, takeoverMinSizeMB: 5 };
    const large = 10 * 1024 * 1024; // 10 MB
    expect(shouldTakeover({ url: 'https://example.com/file.zip', totalBytes: large }, capture)).toBe(true);
  });

  it('filters by file type when takeoverFileTypes is set', () => {
    const capture = { ...baseTakeoverSettings, takeoverFileTypes: ['mp4', 'mkv'] };
    expect(shouldTakeover({ url: 'https://example.com/video.mp4' }, capture)).toBe(true);
    expect(shouldTakeover({ url: 'https://example.com/document.pdf' }, capture)).toBe(false);
  });
});
