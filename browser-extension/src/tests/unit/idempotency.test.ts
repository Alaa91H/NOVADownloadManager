import { describe, expect, it } from 'vitest';
import { idempotencyKeyFor } from '../../outbox/idempotency';

describe('idempotencyKeyFor', () => {
  it('produces a deterministic hex hash for the same candidate', async () => {
    const candidate = { id: 'c1', url: 'https://example.com/video.mp4', source: 'dom' as const, mediaType: 'video' as const, confidence: 75, createdAt: new Date().toISOString() };
    const key1 = await idempotencyKeyFor([candidate]);
    const key2 = await idempotencyKeyFor([candidate]);
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different keys for different candidates', async () => {
    const a = { id: 'c1', url: 'https://example.com/a.mp4', source: 'dom' as const, mediaType: 'video' as const, confidence: 75, createdAt: new Date().toISOString() };
    const b = { id: 'c2', url: 'https://example.com/b.mp4', source: 'dom' as const, mediaType: 'video' as const, confidence: 75, createdAt: new Date().toISOString() };
    const keyA = await idempotencyKeyFor([a]);
    const keyB = await idempotencyKeyFor([b]);
    expect(keyA).not.toBe(keyB);
  });

  it('is order-independent for the same set of candidates', async () => {
    const a = { id: 'c1', url: 'https://example.com/a.mp4', source: 'dom' as const, mediaType: 'video' as const, confidence: 75, createdAt: new Date().toISOString() };
    const b = { id: 'c2', url: 'https://example.com/b.mp4', source: 'dom' as const, mediaType: 'video' as const, confidence: 75, createdAt: new Date().toISOString() };
    const keyAB = await idempotencyKeyFor([a, b]);
    const keyBA = await idempotencyKeyFor([b, a]);
    expect(keyAB).toBe(keyBA);
  });

  it('treats URLs with different query ordering as the same', async () => {
    const a = { id: 'c1', url: 'https://example.com/v.mp4?a=1&b=2', source: 'dom' as const, mediaType: 'video' as const, confidence: 75, createdAt: new Date().toISOString() };
    const b = { id: 'c2', url: 'https://example.com/v.mp4?b=2&a=1', source: 'dom' as const, mediaType: 'video' as const, confidence: 75, createdAt: new Date().toISOString() };
    const keyA = await idempotencyKeyFor([a]);
    const keyB = await idempotencyKeyFor([b]);
    expect(keyA).toBe(keyB);
  });

  it('handles candidates with variants', async () => {
    const candidate = {
      id: 'c1', url: 'https://example.com/master.m3u8', source: 'dom' as const, mediaType: 'video' as const, confidence: 75,
      createdAt: new Date().toISOString(),
      variants: [
        { url: 'https://example.com/1080p.m3u8', width: 1920, height: 1080, bandwidth: 5000000 },
        { url: 'https://example.com/720p.m3u8', width: 1280, height: 720, bandwidth: 2500000 },
      ],
    };
    const key = await idempotencyKeyFor([candidate]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles empty candidate list', async () => {
    const key = await idempotencyKeyFor([]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
