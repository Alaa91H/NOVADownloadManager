import { describe, expect, it } from 'vitest';
import type { Settings } from '../../contracts/settings.schema';
import { defaultSettings } from '../../contracts/settings.schema';

// Mirror production shouldTakeover policy (download-interceptor.ts)
function shouldTakeover(
  item: { url?: string; totalBytes?: number; fileSize?: number; filename?: string },
  capture: Settings['capture'],
): boolean {
  if (!capture.takeoverEnabled && !capture.aggressiveMode) return false;

  const url = item.url ?? '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return false;
    // Match exact host or proper subdomain only (".example.com" matches
    // "a.example.com" but NOT "notexample.com").
    const hostMatches = (list: string[]): boolean =>
      list.some((h) => {
        const lower = h.toLowerCase();
        return host === lower || host.endsWith(`.${lower}`);
      });
    if (hostMatches(capture.neverTakeoverHosts)) {
      if (!hostMatches(capture.alwaysTakeoverHosts)) {
        return false;
      }
    }
    if (hostMatches(capture.alwaysTakeoverHosts)) {
      return true;
    }
  } catch {
    /* malformed URL */
  }

  if (capture.aggressiveMode) return true;

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
  aggressiveMode: false,
  takeoverEnabled: true,
  askBeforeTakeover: false,
  takeoverMinSizeMB: 0,
  takeoverFileTypes: [],
  neverTakeoverHosts: [],
  alwaysTakeoverHosts: [],
};

describe('downloads takeover policy', () => {
  it('returns false when takeover and aggressive are both off', () => {
    const capture = { ...baseTakeoverSettings, takeoverEnabled: false, aggressiveMode: false };
    expect(shouldTakeover({ url: 'https://example.com/file.zip' }, capture)).toBe(false);
  });

  it('returns true when enabled with no restrictions', () => {
    expect(shouldTakeover({ url: 'https://example.com/file.zip' }, baseTakeoverSettings)).toBe(true);
  });

  it('aggressiveMode claims all downloads even when takeoverEnabled is false', () => {
    const capture = { ...baseTakeoverSettings, takeoverEnabled: false, aggressiveMode: true };
    expect(shouldTakeover({ url: 'https://example.com/any.bin', totalBytes: 1 }, capture)).toBe(true);
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

  it('skips files below takeoverMinSizeMB when not aggressive', () => {
    const capture = { ...baseTakeoverSettings, takeoverMinSizeMB: 10, aggressiveMode: false };
    const small = 5 * 1024 * 1024; // 5 MB
    expect(shouldTakeover({ url: 'https://example.com/file.zip', totalBytes: small }, capture)).toBe(false);
  });

  it('accepts files at or above takeoverMinSizeMB', () => {
    const capture = { ...baseTakeoverSettings, takeoverMinSizeMB: 5, aggressiveMode: false };
    const large = 10 * 1024 * 1024; // 10 MB
    expect(shouldTakeover({ url: 'https://example.com/file.zip', totalBytes: large }, capture)).toBe(true);
  });

  it('filters by file type when takeoverFileTypes is set and not aggressive', () => {
    const capture = { ...baseTakeoverSettings, takeoverFileTypes: ['mp4', 'mkv'], aggressiveMode: false };
    expect(shouldTakeover({ url: 'https://example.com/video.mp4' }, capture)).toBe(true);
    expect(shouldTakeover({ url: 'https://example.com/document.pdf' }, capture)).toBe(false);
  });

  it('aggressiveMode ignores size and file-type filters', () => {
    const capture = {
      ...baseTakeoverSettings,
      aggressiveMode: true,
      takeoverMinSizeMB: 100,
      takeoverFileTypes: ['mp4'],
    };
    expect(shouldTakeover({ url: 'https://example.com/document.pdf', totalBytes: 1 }, capture)).toBe(true);
  });

  it('neverTakeoverHosts matches subdomains but NOT unrelated hosts sharing a suffix', () => {
    // Regression: the old `host.endsWith(h)` matched "notexample.com" for h="example.com",
    // wrongly skipping takeover on unrelated hosts. Proper subdomain matching only.
    const capture = { ...baseTakeoverSettings, neverTakeoverHosts: ['example.com'] };
    expect(shouldTakeover({ url: 'https://example.com/file.zip' }, capture)).toBe(false);
    expect(shouldTakeover({ url: 'https://sub.example.com/file.zip' }, capture)).toBe(false);
    // Unrelated host that merely ends with "example.com" — must still be claimed.
    expect(shouldTakeover({ url: 'https://notexample.com/file.zip' }, capture)).toBe(true);
  });

  it('alwaysTakeoverHosts matches subdomains but NOT unrelated hosts sharing a suffix', () => {
    const capture = { ...baseTakeoverSettings, alwaysTakeoverHosts: ['example.com'], takeoverMinSizeMB: 100 };
    expect(shouldTakeover({ url: 'https://example.com/file.zip', totalBytes: 1 }, capture)).toBe(true);
    expect(shouldTakeover({ url: 'https://sub.example.com/file.zip', totalBytes: 1 }, capture)).toBe(true);
    // Unrelated host that merely ends with "example.com" — must NOT be force-claimed.
    expect(shouldTakeover({ url: 'https://notexample.com/file.zip', totalBytes: 1 }, capture)).toBe(false);
  });
});
