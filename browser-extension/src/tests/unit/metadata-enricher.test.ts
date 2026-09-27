import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetadataEnricher } from '../../pipeline/metadata-enricher';

vi.mock('../../pipeline/classifier', () => ({
  classifyCandidate: (c: Record<string, unknown>) => ({ ...c, mediaType: 'video' }),
}));

vi.mock('../../pipeline/normalizer', () => ({
  normalizeCandidate: (c: { url: string; finalUrl?: string }) => ({
    ...c,
    url: c.url.toLowerCase(),
    extension: 'mp4',
  }),
}));

vi.mock('../../pipeline/scorer', () => ({
  CandidateScorer: class {
    score = () => 85;
  },
}));

vi.mock('./filename-extractor', () => ({
  filenameFromContentDisposition: () => undefined,
  filenameFromUrl: (url: string) => {
    const parts = url.split('/');
    return parts[parts.length - 1] || 'unknown';
  },
}));

vi.mock('./size-detector', () => ({
  sizeFromHeaders: () => undefined,
}));

vi.mock('../../utils/url', () => ({
  extensionOf: () => 'mp4',
  normalizeUrl: (u: string) => u.toLowerCase(),
}));

describe('MetadataEnricher', () => {
  let enricher: MetadataEnricher;
  beforeEach(() => { enricher = new MetadataEnricher(); });

  it('enriches a minimal candidate with filename, extension, and confidence', () => {
    const candidate = {
      id: 'c1', url: 'https://example.com/video.mp4', source: 'dom', mediaType: 'unknown', confidence: 50,
      createdAt: new Date().toISOString(),
    } as never;
    const result = enricher.enrich(candidate as never);
    expect(result.url).toBe('https://example.com/video.mp4');
    expect(result.filename).toBe('video.mp4');
    expect(result.confidence).toBe(85);
    expect(result.extension).toBe('mp4');
  });

  it('preserves existing filename and mimeType', () => {
    const candidate = {
      id: 'c1', url: 'https://example.com/v.mp4', source: 'dom', mediaType: 'video', confidence: 50,
      filename: 'my-video.mp4', mimeType: 'video/mp4', createdAt: new Date().toISOString(),
    } as never;
    const result = enricher.enrich(candidate);
    expect(result.filename).toBe('my-video.mp4');
    expect(result.mimeType).toBe('video/mp4');
  });

  it('adds updatedAt timestamp', () => {
    const candidate = {
      id: 'c1', url: 'https://example.com/v.mp4', source: 'dom', mediaType: 'video', confidence: 50,
      createdAt: new Date().toISOString(),
    } as never;
    const result = enricher.enrich(candidate);
    expect(result.updatedAt).toBeDefined();
    expect(new Date(result.updatedAt!).getTime()).not.toBeNaN();
  });
});
