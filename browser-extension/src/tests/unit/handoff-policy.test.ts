import { describe, expect, it } from 'vitest';
import { handoffPolicyDecision } from '../../security/handoff-policy';
import type { Candidate } from '../../contracts/candidate.schema';

function candidate(url: string, mediaType: Candidate['mediaType'] = 'video'): Candidate {
  return {
    id: 'candidate-1',
    url,
    source: mediaType === 'magnet' ? 'context-menu' : 'dom',
    mediaType,
    confidence: 80,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('handoff policy', () => {
  it('allows http and https direct URLs', () => {
    expect(handoffPolicyDecision(candidate('https://example.com/file.mp4')).allowed).toBe(true);
    expect(handoffPolicyDecision(candidate('http://example.com/file.zip')).allowed).toBe(true);
  });

  it('allows magnet links only when classified as magnet candidates', () => {
    expect(handoffPolicyDecision(candidate('magnet:?xt=urn:btih:abcdef', 'magnet')).allowed).toBe(true);
    expect(handoffPolicyDecision(candidate('magnet:?xt=urn:btih:abcdef', 'video')).allowed).toBe(false);
  });

  it('blocks browser-local and ephemeral URLs', () => {
    expect(handoffPolicyDecision(candidate('blob:https://example.com/abc')).allowed).toBe(false);
    expect(handoffPolicyDecision(candidate('data:video/mp4;base64,AAAA')).allowed).toBe(false);
    expect(handoffPolicyDecision(candidate('chrome-extension://abc/file')).allowed).toBe(false);
  });
});
