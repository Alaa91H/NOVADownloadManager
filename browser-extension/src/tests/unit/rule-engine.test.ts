import { describe, expect, it } from 'vitest';
import { Candidate } from '../../contracts/candidate.schema';
import { RuleEngine } from '../../rules/rule-engine';
import { createDefaultSiteRule, SiteRule } from '../../rules/site-rules';

const baseCandidate: Candidate = {
  id: 'c1',
  url: 'https://cdn.example.com/files/video.mp4',
  pageUrl: 'https://www.example.com/watch',
  source: 'dom',
  mediaType: 'video',
  extension: 'mp4',
  sizeBytes: 20 * 1024 * 1024,
  confidence: 80,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('RuleEngine', () => {
  it('filters by wildcard host, media type, min size, and exclude patterns', () => {
    const rule: SiteRule = {
      ...createDefaultSiteRule('*.example.com', '2026-01-01T00:00:00.000Z'),
      mediaTypes: ['video'],
      minSizeMB: 5,
      excludePatterns: ['*thumbnail*'],
    };
    const engine = new RuleEngine([rule]);
    expect(engine.shouldShow(baseCandidate)).toBe(true);
    expect(engine.shouldShow({ ...baseCandidate, mediaType: 'image', url: 'https://www.example.com/image.png' })).toBe(false);
    expect(engine.shouldShow({ ...baseCandidate, sizeBytes: 1024 })).toBe(false);
    expect(engine.shouldShow({ ...baseCandidate, url: 'https://cdn.example.com/thumbnail-video.mp4' })).toBe(false);
  });

  it('only auto-sends when autoCapture is enabled and askBeforeSend is false', () => {
    const rule = { ...createDefaultSiteRule('*.example.com'), autoCapture: true, askBeforeSend: false };
    expect(new RuleEngine([rule]).shouldAutoSend(baseCandidate)).toBe(true);
    expect(new RuleEngine([{ ...rule, askBeforeSend: true }]).shouldAutoSend(baseCandidate)).toBe(false);
  });
});
