/**
 * Capture benchmark — Phase 13.
 *
 * Builds synthetic candidates that mirror the test-page scenarios from the brief
 * (direct mp4/pdf/zip, m3u8, mpd, fetch/XHR media, torrent, magnet, plus noise
 * like tracking pixels, favicons, scripts) and verifies that the evidence-based
 * scoring achieves the required recall / false-positive thresholds.
 *
 * Targets:
 *   - capture recall >= 95% on real downloadable scenarios
 *   - false positive rate <= 5% on noise scenarios
 *   - duplicate rate <= 1% after dedupe
 */

import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../contracts/candidate.schema';
import {
  addEvidence,
  calculateCandidateScore,
  confidenceLevelOf,
  domLinkEvidence,
  networkHeaderEvidence,
  contentDispositionEvidence,
  downloadsApiEvidence,
  hlsManifestEvidence,
  dashManifestEvidence,
  analyticsUrlPenalty,
  faviconPenalty,
  staticAssetPenalty,
  tinyFilePenalty,
} from '../../pipeline/evidence';
import { dedupeCandidates } from '../../pipeline/dedupe';

function base(url: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: crypto.randomUUID(),
    url,
    source: 'dom',
    mediaType: 'other',
    confidence: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Real downloadable scenarios (should be detected — confidence >= 20, not hidden)
// ---------------------------------------------------------------------------

function realScenarios(): Candidate[] {
  return [
    // direct mp4
    addEvidence(base('https://cdn.example.com/movie.mp4', { mediaType: 'video', extension: 'mp4', mimeType: 'video/mp4', sizeBytes: 50_000_000, headers: { contentType: 'video/mp4' } }), networkHeaderEvidence({ mimeType: 'video/mp4' })),
    // direct pdf
    addEvidence(base('https://docs.example.com/report.pdf', { mediaType: 'document', extension: 'pdf', mimeType: 'application/pdf', sizeBytes: 3_000_000, headers: { contentType: 'application/pdf' } }), networkHeaderEvidence({ mimeType: 'application/pdf' })),
    // direct zip
    addEvidence(base('https://files.example.com/archive.zip', { mediaType: 'archive', extension: 'zip', sizeBytes: 20_000_000 }), domLinkEvidence()),
    // content-disposition attachment
    addEvidence(base('https://example.com/download?id=5', { mediaType: 'archive', filename: 'data.zip', headers: { contentDisposition: 'attachment; filename=data.zip' } }), contentDispositionEvidence('data.zip')),
    // redirect to file (downloads api)
    addEvidence(base('https://example.com/dl/9', { mediaType: 'video', finalUrl: 'https://cdn.example.com/final.mp4', extension: 'mp4', sizeBytes: 80_000_000 }), downloadsApiEvidence({ filename: 'final.mp4' })),
    // signed URL mp4
    addEvidence(base('https://s3.amazonaws.com/b/video.mp4?X-Amz-Signature=abc&expires=999', { mediaType: 'video', extension: 'mp4', sizeBytes: 40_000_000 }), domLinkEvidence()),
    // m3u8 master
    addEvidence(base('https://cdn.example.com/master.m3u8', { mediaType: 'manifest', extension: 'm3u8', source: 'hls-manifest' }), hlsManifestEvidence()),
    // m3u8 media
    addEvidence(base('https://cdn.example.com/720p/index.m3u8', { mediaType: 'manifest', extension: 'm3u8', source: 'hls-manifest' }), hlsManifestEvidence()),
    // dash mpd
    addEvidence(base('https://cdn.example.com/manifest.mpd', { mediaType: 'manifest', extension: 'mpd', source: 'dash-manifest' }), dashManifestEvidence()),
    // video element
    addEvidence(base('https://cdn.example.com/clip.webm', { mediaType: 'video', extension: 'webm', source: 'media-element', durationSec: 120 }), domLinkEvidence()),
    // audio element
    addEvidence(base('https://cdn.example.com/song.mp3', { mediaType: 'audio', extension: 'mp3', source: 'media-element', sizeBytes: 5_000_000 }), domLinkEvidence()),
    // fetch-generated media
    addEvidence(base('https://api.example.com/stream/abc.mp4', { mediaType: 'video', extension: 'mp4', sizeBytes: 30_000_000 }), domLinkEvidence({ initiator: 'fetch', via: 'page-tap' })),
    // XHR-generated media
    addEvidence(base('https://api.example.com/x/def.m3u8', { mediaType: 'manifest', extension: 'm3u8', source: 'hls-manifest' }), hlsManifestEvidence()),
    // torrent
    addEvidence(base('https://example.com/file.torrent', { mediaType: 'torrent', extension: 'torrent' }), domLinkEvidence()),
    // magnet
    addEvidence(base('magnet:?xt=urn:btih:abcdef123456', { mediaType: 'magnet' }), domLinkEvidence()),
    // apk installer
    addEvidence(base('https://apps.example.com/app.apk', { mediaType: 'app', extension: 'apk', sizeBytes: 25_000_000 }), domLinkEvidence()),
  ];
}

// ---------------------------------------------------------------------------
// Noise scenarios (should be suppressed — confidence < 20, hidden)
// ---------------------------------------------------------------------------

function noiseScenarios(): Candidate[] {
  return [
    addEvidence(base('https://analytics.example.com/collect?id=1', { mediaType: 'other' }), analyticsUrlPenalty('https://analytics.example.com/collect?id=1')),
    addEvidence(base('https://example.com/favicon.ico', { mediaType: 'other', extension: 'ico' }), faviconPenalty('https://example.com/favicon.ico')),
    addEvidence(base('https://example.com/pixel.gif', { mediaType: 'image', extension: 'gif', sizeBytes: 43 }), tinyFilePenalty(43)),
    addEvidence(base('https://example.com/app.js', { mediaType: 'other', extension: 'js' }), staticAssetPenalty('js')),
    addEvidence(base('https://example.com/style.css', { mediaType: 'other', extension: 'css' }), staticAssetPenalty('css')),
    addEvidence(base('https://example.com/font.woff2', { mediaType: 'other', extension: 'woff2' }), staticAssetPenalty('woff2')),
    addEvidence(base('https://tracking.example.com/beacon', { mediaType: 'other' }), analyticsUrlPenalty('https://tracking.example.com/beacon')),
  ];
}

// ---------------------------------------------------------------------------
// Benchmark assertions
// ---------------------------------------------------------------------------

describe('capture benchmark — recall', () => {
  it('detects >= 95% of real downloadable scenarios (confidence not hidden)', () => {
    const real = realScenarios();
    const detected = real.filter((c) => {
      const score = calculateCandidateScore(c);
      return confidenceLevelOf(score) !== 'hidden';
    });
    const recall = detected.length / real.length;
    expect(recall).toBeGreaterThanOrEqual(0.95);
  });

  it('scores most real scenarios at medium or high confidence', () => {
    const real = realScenarios();
    const strong = real.filter((c) => {
      const level = confidenceLevelOf(calculateCandidateScore(c));
      return level === 'high' || level === 'medium';
    });
    expect(strong.length / real.length).toBeGreaterThanOrEqual(0.7);
  });
});

describe('capture benchmark — false positives', () => {
  it('suppresses >= 95% of noise (false positive rate <= 5%)', () => {
    const noise = noiseScenarios();
    const falsePositives = noise.filter((c) => {
      const score = calculateCandidateScore(c);
      return confidenceLevelOf(score) !== 'hidden';
    });
    const fpRate = falsePositives.length / noise.length;
    expect(fpRate).toBeLessThanOrEqual(0.05);
  });
});

describe('capture benchmark — deduplication', () => {
  it('keeps duplicate rate <= 1% after dedupe', () => {
    const real = realScenarios();
    // Inject exact duplicates (same URL) for half of them
    const withDupes = [...real, ...real.slice(0, 8).map((c) => ({ ...c, id: crypto.randomUUID() }))];
    const deduped = dedupeCandidates(withDupes);
    // After dedupe, count distinct normalized URLs
    const urls = new Set(deduped.map((c) => c.finalUrl ?? c.url));
    const duplicateRate = (deduped.length - urls.size) / Math.max(1, deduped.length);
    expect(duplicateRate).toBeLessThanOrEqual(0.01);
  });

  it('does not merge distinct HLS variants incorrectly', () => {
    const variants = [
      base('https://cdn.example.com/720p/index.m3u8', { mediaType: 'manifest', extension: 'm3u8' }),
      base('https://cdn.example.com/1080p/index.m3u8', { mediaType: 'manifest', extension: 'm3u8' }),
    ];
    const deduped = dedupeCandidates(variants);
    expect(deduped.length).toBe(2);
  });
});
