/**
 * Evidence engine — Phase 2.
 *
 * Every observation about a candidate is stored as an EvidenceItem. The
 * confidence score is *derived* from the evidence list, never set directly by
 * plugins. This makes scoring transparent, testable, and traceable.
 *
 * Design rules:
 * - Positive weight = supporting evidence (the candidate looks downloadable).
 * - Negative weight = penalty (analytics pixel, tiny image, dangerous scheme…).
 * - addEvidence() is the only way to attach evidence; it prevents duplicates.
 * - mergeEvidence() combines two candidate records (e.g. same URL seen from
 *   DOM and network) without losing either trail.
 * - calculateCandidateScore() is pure; it reads evidence[] and candidate fields.
 * - explainCandidate() returns human-readable strings for UI / diagnostics.
 */

import type { Candidate, EvidenceItem, ConfidenceLevel } from '../contracts/candidate.schema';

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Append one evidence item to a candidate, deduplicating by source+reason.
 * Returns a new Candidate (immutable update).
 */
export function addEvidence(candidate: Candidate, item: EvidenceItem): Candidate {
  const existing = candidate.evidence ?? [];
  const isDuplicate = existing.some((e) => e.source === item.source && e.reason === item.reason);
  if (isDuplicate) return candidate;
  return { ...candidate, evidence: [...existing, item] };
}

/**
 * Merge evidence trails from two candidate records that represent the same
 * resource. Uses the *later* observedAt to keep recency. Duplicate
 * source+reason pairs are deduplicated; the higher-weight copy is kept.
 */
export function mergeEvidence(a: Candidate, b: Candidate): Candidate {
  const combined = [...(a.evidence ?? []), ...(b.evidence ?? [])];
  const map = new Map<string, EvidenceItem>();
  for (const item of combined) {
    const key = `${item.source}::${item.reason}`;
    const prev = map.get(key);
    if (!prev || Math.abs(item.weight) > Math.abs(prev.weight)) {
      map.set(key, item);
    }
  }
  const merged = [...map.values()].sort((x, y) => x.observedAt - y.observedAt);
  const base: Candidate = {
    ...a,
    ...b,
    headers: { ...a.headers, ...b.headers },
    variants: b.variants ?? a.variants,
    subtitles: b.subtitles ?? a.subtitles,
    metadata: { ...a.metadata, ...b.metadata },
    updatedAt: new Date().toISOString(),
    evidence: merged,
  };
  return { ...base, confidence: calculateCandidateScore(base) };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Derive a 0–100 confidence score purely from evidence[] + candidate fields.
 *
 * The score is the clamped sum of all evidence weights PLUS fixed bonuses for
 * structural candidate properties (size, variants, filename…). This means:
 * - A candidate with zero evidence starts at 0.
 * - A candidate populated only from the old path (no evidence[]) still gets a
 *   reasonable score via the field-based bonuses below (backward-compat).
 */
export function calculateCandidateScore(candidate: Candidate): number {
  const url = (candidate.finalUrl ?? candidate.url).toLowerCase();

  // --- Sum evidence weights ---
  let score = (candidate.evidence ?? []).reduce((acc, item) => acc + item.weight, 0);

  // --- Field-based bonuses (backward-compat + additional signal) ---
  if (candidate.headers?.contentType || candidate.mimeType) score += 35;
  if (candidate.headers?.contentDisposition) score += 30;
  if (candidate.metadata?.downloadAttribute) score += 30;
  if ((candidate.sizeBytes ?? 0) > 1_024 * 1_024) score += 25;
  if ((candidate.variants?.length ?? 0) > 0) score += 25;
  if (candidate.extension) score += 20;
  if (candidate.source === 'downloads-api') score += 20;
  if (candidate.source === 'media-element') score += 15;
  if (candidate.source === 'hls-manifest' || candidate.source === 'dash-manifest') score += 15;
  if (candidate.metadata?.assistiveSource === 'embedded-media') score += 12;
  if (['video', 'audio', 'document', 'archive', 'app', 'manifest'].includes(candidate.mediaType)) score += 10;
  if (candidate.mediaType === 'torrent' || candidate.mediaType === 'magnet') score += 15;
  if (candidate.filename) score += 10;
  if (/(1080p|720p|2160p|1440p|4k|\d{3,5}k)/i.test(url)) score += 10;

  // --- Field-based penalties ---
  if (/analytics|tracking|pixel|beacon/.test(url)) score -= 50;
  if (/favicon|1x1/.test(url)) score -= 40;
  if (/\.(js|css|woff2?|ttf|otf)(\?|$)/.test(url)) score -= 35;
  if ((candidate.sizeBytes ?? Infinity) < 8 * 1_024) score -= 30;
  if (url.startsWith('blob:') || url.startsWith('data:')) score -= 20;
  if (/thumb|thumbnail/.test(url)) score -= 15;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Map a numeric score to a named confidence level.
 *   high   ≥ 80
 *   medium 50–79
 *   low    20–49
 *   hidden < 20
 */
export function confidenceLevelOf(score: number): ConfidenceLevel {
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  if (score >= 20) return 'low';
  return 'hidden';
}

// ---------------------------------------------------------------------------
// Human-readable explanation
// ---------------------------------------------------------------------------

/**
 * Return an ordered list of human-readable strings describing why this
 * candidate has its current score. Suitable for the "Explain detection" UI.
 *
 * Format:  "[source] reason  (±weight)"
 */
export function explainCandidate(candidate: Candidate): string[] {
  const lines: string[] = [];
  const score = calculateCandidateScore(candidate);
  const level = confidenceLevelOf(score);

  lines.push(`Confidence: ${score}/100 (${level})`);

  if ((candidate.evidence ?? []).length > 0) {
    lines.push('Evidence:');
    for (const item of candidate.evidence ?? []) {
      const sign = item.weight >= 0 ? '+' : '';
      lines.push(`  [${item.source}] ${item.reason}  (${sign}${item.weight})`);
      if (item.details && Object.keys(item.details).length > 0) {
        for (const [k, v] of Object.entries(item.details)) {
          lines.push(`    ${k}: ${String(v)}`);
        }
      }
    }
  } else {
    lines.push('No evidence items recorded (legacy candidate).');
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Evidence factory helpers
// (plugins call these instead of building EvidenceItem objects manually)
// ---------------------------------------------------------------------------

export function evidenceNow(): number {
  return Date.now();
}

/** Direct URL in a DOM link or anchor. */
export function domLinkEvidence(details?: Record<string, unknown>): EvidenceItem {
  return { source: 'dom', reason: 'Direct link found in page DOM', weight: 15, observedAt: evidenceNow(), details };
}

/** Network response header confirmed downloadable content. */
export function networkHeaderEvidence(details?: Record<string, unknown>): EvidenceItem {
  return { source: 'headers', reason: 'Network response headers confirm downloadable content', weight: 35, observedAt: evidenceNow(), details };
}

/** content-disposition: attachment header. */
export function contentDispositionEvidence(filename?: string): EvidenceItem {
  return { source: 'headers', reason: 'Content-Disposition: attachment', weight: 30, observedAt: evidenceNow(), details: filename ? { filename } : undefined };
}

/** Browser downloads API reported this URL. */
export function downloadsApiEvidence(details?: Record<string, unknown>): EvidenceItem {
  return { source: 'downloads-api', reason: 'Browser downloads API intercepted this URL', weight: 40, observedAt: evidenceNow(), details };
}

/** HLS manifest URL detected. */
export function hlsManifestEvidence(details?: Record<string, unknown>): EvidenceItem {
  return { source: 'hls-manifest', reason: 'HLS manifest (.m3u8) URL detected', weight: 30, observedAt: evidenceNow(), details };
}

/** DASH manifest URL detected. */
export function dashManifestEvidence(details?: Record<string, unknown>): EvidenceItem {
  return { source: 'dash-manifest', reason: 'DASH manifest (.mpd) URL detected', weight: 30, observedAt: evidenceNow(), details };
}

/** HTMLMediaElement.src or currentSrc observed. */
export function mediaElementEvidence(kind: 'video' | 'audio', details?: Record<string, unknown>): EvidenceItem {
  return { source: 'media-element', reason: `${kind} element src observed`, weight: 25, observedAt: evidenceNow(), details };
}

/** OpenGraph/twitter media meta tag. */
export function openGraphEvidence(property: string): EvidenceItem {
  return { source: 'opengraph', reason: `OpenGraph/Twitter meta property: ${property}`, weight: 20, observedAt: evidenceNow() };
}

/** JSON-LD structured data. */
export function jsonLdEvidence(type: string): EvidenceItem {
  return { source: 'jsonld', reason: `JSON-LD structured data type: ${type}`, weight: 20, observedAt: evidenceNow() };
}

/** HTTP redirect resolved to a new URL. */
export function redirectEvidence(fromUrl: string): EvidenceItem {
  return { source: 'redirect', reason: 'HTTP redirect resolved to final URL', weight: 10, observedAt: evidenceNow(), details: { fromUrl } };
}

/** Context menu click on a link/media element. */
export function contextMenuEvidence(details?: Record<string, unknown>): EvidenceItem {
  return { source: 'context-menu', reason: 'User right-clicked and selected download via context menu', weight: 45, observedAt: evidenceNow(), details };
}

// --- Penalty evidence ---

/** URL matches analytics/tracking/pixel pattern. */
export function analyticsUrlPenalty(url: string): EvidenceItem {
  return { source: 'dom', reason: 'URL matches analytics/tracking/pixel pattern', weight: -50, observedAt: evidenceNow(), details: { url } };
}

/** URL matches favicon/1x1 image pattern. */
export function faviconPenalty(url: string): EvidenceItem {
  return { source: 'dom', reason: 'URL matches favicon or 1×1 tracking pixel pattern', weight: -40, observedAt: evidenceNow(), details: { url } };
}

/** URL is a script, stylesheet, or web font. */
export function staticAssetPenalty(ext: string): EvidenceItem {
  return { source: 'dom', reason: `URL is a static web asset (${ext}) not a downloadable file`, weight: -35, observedAt: evidenceNow() };
}

/** File is too small to be a real download. */
export function tinyFilePenalty(sizeBytes: number): EvidenceItem {
  return { source: 'headers', reason: `File size too small to be a real download (${sizeBytes} bytes)`, weight: -30, observedAt: evidenceNow(), details: { sizeBytes } };
}

/** URL uses a non-downloadable scheme (blob:, data:, javascript:). */
export function dangerousSchemePenalty(scheme: string): EvidenceItem {
  return { source: 'dom', reason: `Non-downloadable URL scheme: ${scheme}`, weight: -20, observedAt: evidenceNow() };
}

/** URL matches thumbnail/preview pattern. */
export function thumbnailPenalty(url: string): EvidenceItem {
  return { source: 'dom', reason: 'URL matches thumbnail/preview pattern', weight: -15, observedAt: evidenceNow(), details: { url } };
}
