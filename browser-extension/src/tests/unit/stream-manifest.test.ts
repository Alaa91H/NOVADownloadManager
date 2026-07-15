import { describe, expect, it } from 'vitest';
import {
  StreamManifestCandidateSchema,
  StreamResolveRequestSchema,
  StreamResolveResponseSchema,
  StreamAddRequestSchema,
} from '../../contracts/nova.protocol.v4';

const baseManifest = {
  kind: 'stream.manifest' as const,
  manifestType: 'hls' as const,
  url: 'https://cdn.example.com/stream.m3u8',
  pageUrl: 'https://example.com/watch',
  detectedBy: ['hls-capture'],
  evidence: [],
  drmProtected: false,
  resolver: {
    preferred: 'desktop' as const,
    canRefresh: true,
    canMerge: true,
    canSelectQuality: true,
  },
};

describe('StreamManifestCandidateSchema', () => {
  it('validates a valid HLS manifest candidate', () => {
    expect(StreamManifestCandidateSchema.safeParse(baseManifest).success).toBe(true);
  });

  it('validates a valid DASH manifest candidate', () => {
    const dash = { ...baseManifest, manifestType: 'dash' as const, url: 'https://cdn.example.com/manifest.mpd' };
    expect(StreamManifestCandidateSchema.safeParse(dash).success).toBe(true);
  });

  it('rejects when kind is not stream.manifest', () => {
    const bad = { ...baseManifest, kind: 'direct' };
    expect(StreamManifestCandidateSchema.safeParse(bad).success).toBe(false);
  });

  it('marks DRM-protected manifest correctly', () => {
    const drm = { ...baseManifest, drmProtected: true };
    const parsed = StreamManifestCandidateSchema.safeParse(drm);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.drmProtected).toBe(true);
  });

  it('resolver always has preferred: desktop', () => {
    const parsed = StreamManifestCandidateSchema.safeParse(baseManifest);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.resolver.preferred).toBe('desktop');
  });
});

describe('StreamResolveRequestSchema', () => {
  it('validates a resolve request', () => {
    const req = { manifestType: 'hls' as const, url: 'https://cdn.example.com/stream.m3u8' };
    expect(StreamResolveRequestSchema.safeParse(req).success).toBe(true);
  });
});

describe('StreamResolveResponseSchema', () => {
  it('validates a resolve response with qualities', () => {
    const resp = {
      ok: true,
      manifestType: 'hls',
      qualities: [{ url: 'https://cdn.example.com/1080p.m3u8', height: 1080, bandwidth: 5000000 }],
      durationSec: 3600,
      isLive: false,
      drmProtected: false,
    };
    expect(StreamResolveResponseSchema.safeParse(resp).success).toBe(true);
  });

  it('defaults to empty arrays for qualities/subtitles/audioTracks', () => {
    const resp = { ok: true };
    const parsed = StreamResolveResponseSchema.safeParse(resp);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.qualities).toEqual([]);
      expect(parsed.data.subtitleTracks).toEqual([]);
      expect(parsed.data.audioTracks).toEqual([]);
    }
  });
});

describe('StreamAddRequestSchema', () => {
  it('validates a stream add request', () => {
    const req = {
      idempotencyKey: 'a'.repeat(16),
      manifest: baseManifest,
      source: 'nova-extension' as const,
    };
    expect(StreamAddRequestSchema.safeParse(req).success).toBe(true);
  });
});
