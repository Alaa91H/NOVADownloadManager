import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, unknown>();

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: {
        async get(key: string | null) {
          if (key === null) {
            return Object.fromEntries(storage.entries());
          }
          if (typeof key === 'string') {
            return storage.has(key) ? { [key]: storage.get(key) } : {};
          }
          return {};
        },
        async set(values: Record<string, unknown>) {
          for (const [k, v] of Object.entries(values)) storage.set(k, v);
        },
        async remove(keys: string | string[]) {
          for (const k of Array.isArray(keys) ? keys : [keys]) storage.delete(k);
        },
      },
    },
    tabs: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { CandidateCache } from '../../storage/candidate-cache';
import type { Candidate } from '../../contracts/candidate.schema';

function cand(partial: Partial<Candidate> & Pick<Candidate, 'id' | 'url' | 'source' | 'mediaType'>): Candidate {
  return {
    confidence: 50,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('CandidateCache.replaceWithScan', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('keeps passive network captures when a DOM scan finds nothing', async () => {
    const cache = new CandidateCache();
    const tabId = 7;
    await cache.set(tabId, [
      cand({
        id: 'net-1',
        url: 'https://cdn.example/video.mp4',
        source: 'network',
        mediaType: 'video',
        mimeType: 'video/mp4',
        confidence: 70,
      }),
      cand({
        id: 'dom-old',
        url: 'https://example.com/old.mp4',
        source: 'dom',
        mediaType: 'video',
        confidence: 40,
      }),
    ]);

    const scanned = [
      cand({
        id: 'dom-new',
        url: 'https://example.com/new.mp4',
        source: 'dom',
        mediaType: 'video',
        confidence: 45,
      }),
    ];

    const merged = await cache.replaceWithScan(tabId, scanned);
    const urls = merged.map((c) => c.url).sort();

    expect(urls).toContain('https://cdn.example/video.mp4');
    expect(urls).toContain('https://example.com/new.mp4');
    expect(urls).not.toContain('https://example.com/old.mp4');
  });

  it('keeps page-tap assistive captures across scan', async () => {
    const cache = new CandidateCache();
    const tabId = 3;
    await cache.set(tabId, [
      cand({
        id: 'tap-1',
        url: 'https://googlevideo.com/videoplayback?id=1',
        source: 'dom',
        mediaType: 'video',
        confidence: 60,
        metadata: { assistiveSource: 'page-tap-live-quality' },
      }),
    ]);

    const merged = await cache.replaceWithScan(tabId, []);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.url).toContain('videoplayback');
  });
});
