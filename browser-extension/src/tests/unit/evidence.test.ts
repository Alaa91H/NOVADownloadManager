import { describe, expect, it } from 'vitest';
import {
  addEvidence,
  mergeEvidence,
  calculateCandidateScore,
  confidenceLevelOf,
  explainCandidate,
  domLinkEvidence,
  networkHeaderEvidence,
  contentDispositionEvidence,
  downloadsApiEvidence,
  hlsManifestEvidence,
  analyticsUrlPenalty,
  faviconPenalty,
  tinyFilePenalty,
  dangerousSchemePenalty,
} from '../../pipeline/evidence';
import type { Candidate } from '../../contracts/candidate.schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'test-id',
    url: 'https://cdn.example.com/video.mp4',
    source: 'dom',
    mediaType: 'video',
    confidence: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// addEvidence
// ---------------------------------------------------------------------------

describe('addEvidence', () => {
  it('attaches a new evidence item to a candidate with no existing evidence', () => {
    const c = baseCandidate();
    const item = domLinkEvidence({ tag: 'a' });
    const result = addEvidence(c, item);
    expect(result.evidence).toHaveLength(1);
    const first = result.evidence?.[0];
    expect(first?.source).toBe('dom');
  });

  it('does not mutate the original candidate', () => {
    const c = baseCandidate();
    addEvidence(c, domLinkEvidence());
    expect(c.evidence).toBeUndefined();
  });

  it('deduplicates evidence with identical source + reason', () => {
    const item = domLinkEvidence({ tag: 'a' });
    let c = addEvidence(baseCandidate(), item);
    c = addEvidence(c, item);
    expect(c.evidence).toHaveLength(1);
  });

  it('allows two items from the same source with different reasons', () => {
    const c = baseCandidate();
    const a = { ...domLinkEvidence(), reason: 'reason-A' };
    const b = { ...domLinkEvidence(), reason: 'reason-B' };
    const result = addEvidence(addEvidence(c, a), b);
    expect(result.evidence).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// mergeEvidence
// ---------------------------------------------------------------------------

describe('mergeEvidence', () => {
  it('combines evidence trails from two candidates', () => {
    const a = addEvidence(baseCandidate(), domLinkEvidence());
    const b = addEvidence(baseCandidate(), networkHeaderEvidence({ mimeType: 'video/mp4' }));
    const merged = mergeEvidence(a, b);
    expect(merged.evidence!.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the higher-weight item when the same source+reason appears in both', () => {
    const low = { source: 'dom' as const, reason: 'Direct link found in page DOM', weight: 5, observedAt: Date.now() };
    const high = { source: 'dom' as const, reason: 'Direct link found in page DOM', weight: 15, observedAt: Date.now() };
    const a = { ...baseCandidate(), evidence: [low] };
    const b = { ...baseCandidate(), evidence: [high] };
    const merged = mergeEvidence(a, b);
    const domItem = merged.evidence?.find((e) => e.source === 'dom');
    expect(domItem?.weight).toBe(15);
  });

  it('recalculates confidence after merging', () => {
    const a = addEvidence(baseCandidate(), contentDispositionEvidence('video.mp4'));
    const b = addEvidence(baseCandidate(), downloadsApiEvidence({ filename: 'video.mp4' }));
    const merged = mergeEvidence(a, b);
    expect(merged.confidence).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// calculateCandidateScore
// ---------------------------------------------------------------------------

describe('calculateCandidateScore', () => {
  it('scores a rich candidate (evidence + structural fields) above 80', () => {
    let c = baseCandidate({
      mimeType: 'video/mp4',
      sizeBytes: 10_000_000,
      filename: 'movie.mp4',
      extension: 'mp4',
      source: 'downloads-api',
      headers: { contentDisposition: 'attachment; filename=movie.mp4' },
    });
    c = addEvidence(c, downloadsApiEvidence({ filename: 'movie.mp4' }));
    c = addEvidence(c, contentDispositionEvidence('movie.mp4'));
    const score = calculateCandidateScore(c);
    expect(score).toBeGreaterThan(80);
  });

  it('penalises analytics/tracking URLs heavily', () => {
    const c = baseCandidate({ url: 'https://analytics.example.com/pixel?id=1' });
    const penalised = addEvidence(c, analyticsUrlPenalty(c.url));
    const score = calculateCandidateScore(penalised);
    expect(score).toBeLessThan(20);
  });

  it('penalises 1×1 favicon/tracking pixels', () => {
    const c = baseCandidate({ url: 'https://example.com/favicon.ico' });
    const penalised = addEvidence(c, faviconPenalty(c.url));
    expect(calculateCandidateScore(penalised)).toBeLessThan(20);
  });

  it('penalises tiny files', () => {
    const c = addEvidence(baseCandidate({ sizeBytes: 512 }), tinyFilePenalty(512));
    expect(calculateCandidateScore(c)).toBeLessThan(10);
  });

  it('penalises blob: and data: scheme candidates', () => {
    const c = addEvidence(
      baseCandidate({ url: 'blob:https://example.com/abc' }),
      dangerousSchemePenalty('blob'),
    );
    expect(calculateCandidateScore(c)).toBeLessThan(20);
  });

  it('clamps result to [0, 100]', () => {
    // Accumulate massive positive evidence
    let c = baseCandidate({ mimeType: 'video/mp4', sizeBytes: 1_000_000_000 });
    for (let i = 0; i < 20; i++) {
      c = addEvidence(c, { source: 'headers', reason: `evidence-${i}`, weight: 100, observedAt: Date.now() });
    }
    expect(calculateCandidateScore(c)).toBeLessThanOrEqual(100);

    // Accumulate massive negative evidence
    let c2 = baseCandidate();
    for (let i = 0; i < 20; i++) {
      c2 = addEvidence(c2, { source: 'dom', reason: `penalty-${i}`, weight: -100, observedAt: Date.now() });
    }
    expect(calculateCandidateScore(c2)).toBeGreaterThanOrEqual(0);
  });

  it('scores a legacy candidate (no evidence[]) using field bonuses only', () => {
    const legacy = baseCandidate({
      mimeType: 'application/pdf',
      sizeBytes: 5_000_000,
      filename: 'doc.pdf',
      extension: 'pdf',
      source: 'dom',
      mediaType: 'document',
      headers: { contentType: 'application/pdf' },
    });
    // No evidence array — should still produce a reasonable score from field bonuses
    expect(calculateCandidateScore(legacy)).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------
// confidenceLevelOf
// ---------------------------------------------------------------------------

describe('confidenceLevelOf', () => {
  it('maps score ≥ 80 to high', () => expect(confidenceLevelOf(80)).toBe('high'));
  it('maps score 50–79 to medium', () => {
    expect(confidenceLevelOf(50)).toBe('medium');
    expect(confidenceLevelOf(79)).toBe('medium');
  });
  it('maps score 20–49 to low', () => {
    expect(confidenceLevelOf(20)).toBe('low');
    expect(confidenceLevelOf(49)).toBe('low');
  });
  it('maps score < 20 to hidden', () => {
    expect(confidenceLevelOf(0)).toBe('hidden');
    expect(confidenceLevelOf(19)).toBe('hidden');
  });
});

// ---------------------------------------------------------------------------
// explainCandidate
// ---------------------------------------------------------------------------

describe('explainCandidate', () => {
  it('includes the numeric score and level in the first line', () => {
    let c = baseCandidate({ mimeType: 'video/mp4', extension: 'mp4' });
    c = addEvidence(c, hlsManifestEvidence());
    const lines = explainCandidate(c);
    expect(lines[0]).toMatch(/Confidence: \d+\/100/);
    expect(lines[0]).toMatch(/\b(high|medium|low|hidden)\b/);
  });

  it('lists each evidence item with its source, reason and weight', () => {
    let c = baseCandidate();
    c = addEvidence(c, domLinkEvidence({ tag: 'a' }));
    c = addEvidence(c, contentDispositionEvidence('file.zip'));
    const lines = explainCandidate(c);
    expect(lines.some((l) => l.includes('[dom]'))).toBe(true);
    expect(lines.some((l) => l.includes('[headers]'))).toBe(true);
  });

  it('shows a friendly message for legacy candidates with no evidence[]', () => {
    const legacy = baseCandidate();
    const lines = explainCandidate(legacy);
    expect(lines.some((l) => l.includes('legacy'))).toBe(true);
  });
});
