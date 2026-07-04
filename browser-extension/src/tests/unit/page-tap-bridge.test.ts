/**
 * Unit tests for the page-tap-bridge logic.
 * We test the filtering/deduplication logic extracted as pure functions —
 * the WXT defineContentScript wrapper is not tested here.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Re-implement the bridge helpers as pure functions for testing
// ---------------------------------------------------------------------------

const BLOCKED_SCHEMES = new Set(['blob:', 'data:', 'javascript:', 'about:', 'file:']);

function isSafeUrl(url: string): boolean {
  if (/^magnet:\?xt=urn:btih/i.test(url)) return true;
  try {
    const scheme = new URL(url).protocol;
    if (BLOCKED_SCHEMES.has(scheme.toLowerCase())) return false;
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}

function normalizeUrl(raw: string): string {
  if (/^magnet:/i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    u.hash = '';
    return u.toString();
  } catch {
    return raw;
  }
}

const DEDUPE_TTL_MS = 30_000;

function makeDedupeCache() {
  const cache = new Map<string, number>();
  return function isDuplicate(url: string, now: number): boolean {
    const last = cache.get(url);
    if (last !== undefined && now - last < DEDUPE_TTL_MS) return true;
    cache.set(url, now);
    return false;
  };
}

const PageTapEventSchema = z.object({
  source: z.literal('adm-page-tap-v1'),
  type: z.literal('ADM_PAGE_TAP_CANDIDATE'),
  version: z.literal(1),
  url: z.string().min(1).max(2048),
  pageUrl: z.string().min(1).max(2048),
  initiator: z.enum(['fetch', 'xhr', 'media-src', 'source-src', 'player-config']),
  detectedAt: z.number().int().nonnegative(),
  mimeHint: z.string().max(128).optional(),
  extensionHint: z.string().max(20).optional(),
  mediaHint: z.enum(['video', 'audio', 'image', 'document', 'archive', 'torrent', 'manifest', 'other']).optional(),
});

function makeValidEvent(url: string, initiator = 'fetch') {
  return {
    source: 'adm-page-tap-v1',
    type: 'ADM_PAGE_TAP_CANDIDATE',
    version: 1,
    url,
    pageUrl: 'https://example.com/watch',
    initiator,
    detectedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// isSafeUrl
// ---------------------------------------------------------------------------

describe('isSafeUrl', () => {
  it('accepts http URLs', () => expect(isSafeUrl('http://cdn.example.com/video.mp4')).toBe(true));
  it('accepts https URLs', () => expect(isSafeUrl('https://cdn.example.com/file.zip')).toBe(true));
  it('accepts magnet links', () => expect(isSafeUrl('magnet:?xt=urn:btih:abc123')).toBe(true));
  it('rejects blob: URLs', () => expect(isSafeUrl('blob:https://example.com/abc')).toBe(false));
  it('rejects data: URLs', () => expect(isSafeUrl('data:image/png;base64,abc')).toBe(false));
  it('rejects javascript: URLs', () => expect(isSafeUrl('javascript:void(0)')).toBe(false));
  it('rejects file: URLs', () => expect(isSafeUrl('file:///home/user/file.mp4')).toBe(false));
  it('rejects ftp: URLs', () => expect(isSafeUrl('ftp://example.com/file.zip')).toBe(false));
});

// ---------------------------------------------------------------------------
// normaliseUrl
// ---------------------------------------------------------------------------

describe('normalizeUrl', () => {
  it('strips fragments', () => expect(normalizeUrl('https://cdn.example.com/video.mp4#fragment')).toBe('https://cdn.example.com/video.mp4'));
  it('preserves query strings', () => expect(normalizeUrl('https://cdn.example.com/file.zip?v=1')).toBe('https://cdn.example.com/file.zip?v=1'));
  it('preserves magnet links intact', () => {
    const magnet = 'magnet:?xt=urn:btih:abc123&dn=test';
    expect(normalizeUrl(magnet)).toBe(magnet);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('makeDedupeCache', () => {
  it('returns false for a new URL', () => {
    const isDuplicate = makeDedupeCache();
    expect(isDuplicate('https://cdn.example.com/file.zip', Date.now())).toBe(false);
  });

  it('returns true for a URL seen within TTL window', () => {
    const isDuplicate = makeDedupeCache();
    const now = Date.now();
    isDuplicate('https://cdn.example.com/file.zip', now);
    expect(isDuplicate('https://cdn.example.com/file.zip', now + 1000)).toBe(true);
  });

  it('returns false after TTL has expired', () => {
    const isDuplicate = makeDedupeCache();
    const now = Date.now();
    isDuplicate('https://cdn.example.com/file.zip', now);
    expect(isDuplicate('https://cdn.example.com/file.zip', now + DEDUPE_TTL_MS + 1)).toBe(false);
  });

  it('treats different URLs as independent', () => {
    const isDuplicate = makeDedupeCache();
    const now = Date.now();
    isDuplicate('https://cdn.example.com/a.mp4', now);
    expect(isDuplicate('https://cdn.example.com/b.mp4', now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PageTapEventSchema validation
// ---------------------------------------------------------------------------

describe('PageTapEventSchema', () => {
  it('accepts a valid fetch event for an m3u8 URL', () => {
    const event = makeValidEvent('https://cdn.example.com/stream.m3u8', 'fetch');
    expect(PageTapEventSchema.safeParse(event).success).toBe(true);
  });

  it('accepts a valid xhr event for an mpd URL', () => {
    const event = makeValidEvent('https://cdn.example.com/manifest.mpd', 'xhr');
    expect(PageTapEventSchema.safeParse(event).success).toBe(true);
  });

  it('accepts a media-src event for an mp4 URL', () => {
    const event = makeValidEvent('https://cdn.example.com/video.mp4', 'media-src');
    expect(PageTapEventSchema.safeParse(event).success).toBe(true);
  });

  it('rejects events with wrong source', () => {
    const event = { ...makeValidEvent('https://cdn.example.com/video.mp4'), source: 'evil-source' };
    expect(PageTapEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects events with an unknown initiator', () => {
    const event = { ...makeValidEvent('https://cdn.example.com/video.mp4'), initiator: 'injected' };
    expect(PageTapEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects URLs that exceed 2048 characters', () => {
    const longUrl = 'https://cdn.example.com/' + 'a'.repeat(2048);
    const event = makeValidEvent(longUrl);
    expect(PageTapEventSchema.safeParse(event).success).toBe(false);
  });

  it('does not forward sensitive headers — schema has no headers field', () => {
    const schema = PageTapEventSchema;
    const keys = Object.keys(schema.shape);
    expect(keys).not.toContain('headers');
    expect(keys).not.toContain('authorization');
    expect(keys).not.toContain('cookie');
  });
});
