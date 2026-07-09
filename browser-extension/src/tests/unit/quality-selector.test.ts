import { describe, expect, it } from 'vitest';
import {
  StreamResolveRequestSchema,
  StreamResolveResponseSchema,
  StreamAddRequestSchema,
  StreamManifestCandidateSchema,
} from '../../contracts/nova.protocol.v4';

// Mirror the qualityLabel helper from QualitySelector for pure-logic testing.
function qualityLabel(q: { label?: string; width?: number; height?: number; bandwidth?: number }): string {
  if (q.label) return q.label;
  if (q.height) return `${q.height}p${q.width ? ` (${q.width}×${q.height})` : ''}`;
  if (q.bandwidth) return `${Math.round(q.bandwidth / 1000)} kbps`;
  return 'unknown';
}

describe('quality selector — resolve contract', () => {
  it('builds a valid RESOLVE_STREAM request payload', () => {
    const req = { manifestType: 'hls' as const, url: 'https://cdn.example.com/master.m3u8', pageUrl: 'https://example.com/watch' };
    expect(StreamResolveRequestSchema.safeParse(req).success).toBe(true);
  });

  it('parses an NOVA resolve response with multiple qualities', () => {
    const resp = {
      ok: true,
      manifestType: 'hls',
      qualities: [
        { url: 'https://cdn.example.com/2160p.m3u8', width: 3840, height: 2160, bandwidth: 15000000, label: '2160p' },
        { url: 'https://cdn.example.com/1080p.m3u8', width: 1920, height: 1080, bandwidth: 5000000, label: '1080p' },
        { url: 'https://cdn.example.com/720p.m3u8', width: 1280, height: 720, bandwidth: 2800000, label: '720p' },
      ],
      durationSec: 3600,
      isLive: false,
      drmProtected: false,
    };
    const parsed = StreamResolveResponseSchema.safeParse(resp);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.qualities).toHaveLength(3);
  });
});

describe('quality selector — send contract', () => {
  const manifest = {
    kind: 'stream.manifest' as const,
    manifestType: 'hls' as const,
    url: 'https://cdn.example.com/master.m3u8',
    detectedBy: ['hls-manifest'],
    evidence: [],
    drmProtected: false,
    resolver: { preferred: 'desktop' as const, canRefresh: true, canMerge: true, canSelectQuality: true },
  };

  it('builds a valid SEND_STREAM (add) request with a chosen quality', () => {
    expect(StreamManifestCandidateSchema.safeParse(manifest).success).toBe(true);
    const req = {
      idempotencyKey: 'a'.repeat(16),
      manifest,
      selectedQuality: { url: 'https://cdn.example.com/1080p.m3u8', height: 1080, bandwidth: 5000000 },
      source: 'nova-extension' as const,
    };
    expect(StreamAddRequestSchema.safeParse(req).success).toBe(true);
  });

  it('allows sending without a selected quality (let NOVA pick best)', () => {
    const req = { idempotencyKey: 'b'.repeat(16), manifest, source: 'nova-extension' as const };
    expect(StreamAddRequestSchema.safeParse(req).success).toBe(true);
  });
});

describe('quality selector — label formatting', () => {
  it('prefers explicit label', () => {
    expect(qualityLabel({ label: '1080p', height: 1080 })).toBe('1080p');
  });

  it('falls back to height with resolution', () => {
    expect(qualityLabel({ width: 1920, height: 1080 })).toBe('1080p (1920×1080)');
  });

  it('falls back to bitrate when no resolution', () => {
    expect(qualityLabel({ bandwidth: 2800000 })).toBe('2800 kbps');
  });

  it('returns unknown when no info', () => {
    expect(qualityLabel({})).toBe('unknown');
  });
});

describe('quality selector — send response interpretation', () => {
  // Mirrors the QualitySelector.send() result handling
  function interpret(result: { ok?: boolean; accepted?: boolean; duplicate?: boolean; message?: string }, qualityUrl?: string): { kind: 'success' | 'duplicate' | 'error'; text: string } {
    const label = qualityUrl ? 'selected quality' : 'best quality (NOVA choice)';
    if (result?.duplicate) return { kind: 'duplicate', text: `Already queued in NOVA (${label}).` };
    if (result?.ok === false || result?.accepted === false) return { kind: 'error', text: result?.message ?? 'NOVA did not accept the stream.' };
    return { kind: 'success', text: `Sent to NOVA: ${label}.` };
  }

  it('reports success when NOVA accepts', () => {
    const r = interpret({ ok: true, accepted: true, taskId: 'x' } as never, 'https://cdn.example.com/1080p.m3u8');
    expect(r.kind).toBe('success');
    expect(r.text).toContain('selected quality');
  });

  it('reports duplicate when NOVA says duplicate', () => {
    const r = interpret({ ok: true, duplicate: true } as never, undefined);
    expect(r.kind).toBe('duplicate');
    expect(r.text).toContain('best quality');
  });

  it('reports error when NOVA rejects', () => {
    const r = interpret({ ok: false, message: 'rejected by daemon' } as never, undefined);
    expect(r.kind).toBe('error');
    expect(r.text).toBe('rejected by daemon');
  });

  it('reports error with default message when none provided', () => {
    const r = interpret({ accepted: false } as never, undefined);
    expect(r.kind).toBe('error');
    expect(r.text).toMatch(/did not accept/i);
  });
});

describe('quality selector — IDM-style column formatting', () => {
  function codecShort(codecs?: string): string | undefined {
    if (!codecs) return undefined;
    const c = codecs.toLowerCase();
    if (c.includes('av01')) return 'AV1';
    if (c.includes('hev') || c.includes('hvc')) return 'H.265';
    if (c.includes('avc')) return 'H.264';
    if (c.includes('vp9') || c.includes('vp09')) return 'VP9';
    return codecs.split('.')[0];
  }
  function sizeText(q: { estimatedSizeBytes?: number; bandwidth?: number }, durationSec?: number): string {
    if (q.estimatedSizeBytes) return 'exact';
    if (q.bandwidth && durationSec) return 'estimated';
    return '—';
  }

  it('maps avc1 codecs to H.264', () => expect(codecShort('avc1.640028')).toBe('H.264'));
  it('maps hev1/hvc1 to H.265', () => expect(codecShort('hvc1.1.6.L93')).toBe('H.265'));
  it('maps av01 to AV1', () => expect(codecShort('av01.0.08M.08')).toBe('AV1'));
  it('maps vp9 to VP9', () => expect(codecShort('vp09.00.10.08')).toBe('VP9'));
  it('returns undefined for missing codecs', () => expect(codecShort(undefined)).toBeUndefined());

  it('uses exact size when NOVA reports per-quality bytes', () => {
    expect(sizeText({ estimatedSizeBytes: 2_250_000_000 }, 3600)).toBe('exact');
  });
  it('estimates size from bitrate × duration when no exact size', () => {
    expect(sizeText({ bandwidth: 5000000 }, 3600)).toBe('estimated');
  });
  it('shows dash when neither size nor duration available', () => {
    expect(sizeText({ bandwidth: 5000000 }, undefined)).toBe('—');
  });
});

describe('quality selector — sort order', () => {
  it('sorts qualities highest resolution first', () => {
    const list = [
      { url: 'a', height: 480, bandwidth: 1400000 },
      { url: 'b', height: 2160, bandwidth: 15000000 },
      { url: 'c', height: 1080, bandwidth: 5000000 },
    ];
    const sorted = [...list].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
    expect(sorted.map((q) => q.height)).toEqual([2160, 1080, 480]);
  });
});

describe('quality selector — selected quality lookup', () => {
  // Mirrors message-router sendStream variant lookup
  const variants = [
    { url: 'https://cdn.example.com/1080p.m3u8', width: 1920, height: 1080, bandwidth: 5000000 },
    { url: 'https://cdn.example.com/720p.m3u8', width: 1280, height: 720, bandwidth: 2800000 },
  ];

  function findSelected(selectedQualityUrl?: string) {
    return selectedQualityUrl
      ? variants.filter((v) => v.url === selectedQualityUrl).map((v) => ({ url: v.url, width: v.width, height: v.height, bandwidth: v.bandwidth }))[0]
      : undefined;
  }

  it('finds the matching variant by URL', () => {
    const result = findSelected('https://cdn.example.com/720p.m3u8');
    expect(result?.height).toBe(720);
  });

  it('returns undefined for an unknown URL', () => {
    expect(findSelected('https://cdn.example.com/nonexistent.m3u8')).toBeUndefined();
  });

  it('returns undefined when no quality is selected (auto mode)', () => {
    expect(findSelected(undefined)).toBeUndefined();
  });
});
