import { describe, expect, it } from 'vitest';
import { classifyCandidate } from '../../pipeline/classifier';

describe('classifyCandidate', () => {
  it('preserves explicit media-element video type when URL inference is unknown', () => {
    const candidate = classifyCandidate({
      id: 'c1',
      url: 'blob:https://example.com/session-media',
      source: 'media-element',
      mediaType: 'video',
      confidence: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(candidate.mediaType).toBe('video');
  });

  it('uses final URL and MIME evidence when available', () => {
    const candidate = classifyCandidate({
      id: 'c2',
      url: 'https://redirect.example.com/download',
      finalUrl: 'https://cdn.example.com/archive.zip',
      source: 'network',
      mediaType: 'other',
      mimeType: 'application/octet-stream',
      confidence: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(candidate.mediaType).toBe('archive');
  });
});
