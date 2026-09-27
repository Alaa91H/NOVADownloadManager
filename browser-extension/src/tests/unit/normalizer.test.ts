import { describe, expect, it, vi } from 'vitest';
import { normalizeCandidate } from '../../pipeline/normalizer';

vi.mock('../../utils/url', () => ({
  normalizeUrl: (u: string) => u.replace(/\/$/, '').toLowerCase(),
  extensionOf: (u: string) => {
    const m = u?.match(/\.(\w+)(?:\?|$)/);
    return m?.[1] ?? 'unknown';
  },
}));

describe('normalizeCandidate', () => {
  it('normalizes URL and derives extension', () => {
    const c = { id: 'c1', url: 'https://Example.com/Video.MP4', source: 'dom' as const, mediaType: 'video' as const, confidence: 75, createdAt: new Date().toISOString() };
    const result = normalizeCandidate(c);
    expect(result.url).toBe('https://example.com/video.mp4');
    expect(result.extension).toBe('mp4');
  });

  it('preserves extension when already set', () => {
    const c = { id: 'c1', url: 'https://example.com/video.mp4', source: 'dom' as const, mediaType: 'video' as const, extension: 'mkv', confidence: 75, createdAt: new Date().toISOString() };
    const result = normalizeCandidate(c);
    expect(result.extension).toBe('mkv');
  });

  it('normalizes finalUrl if present', () => {
    const c = { id: 'c1', url: 'https://example.com/redirect', finalUrl: 'https://CDN.net/file.MKV', source: 'dom' as const, mediaType: 'video' as const, confidence: 75, createdAt: new Date().toISOString() };
    const result = normalizeCandidate(c);
    expect(result.finalUrl).toBe('https://cdn.net/file.mkv');
    expect(result.extension).toBe('mkv');
  });
});
