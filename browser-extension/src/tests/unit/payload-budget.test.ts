import { describe, expect, it } from 'vitest';
import { assertHandoffPayloadBudget } from '../../security/payload-budget';
import { NovaExtensionError } from '../../core/error-classification';
import {
  MAX_CANDIDATE_SUBTITLES,
  MAX_CANDIDATE_URL_CHARS,
  MAX_CANDIDATE_VARIANTS,
  MAX_HANDOFF_CANDIDATES,
} from '../../contracts/limits';
import type { Candidate } from '../../contracts/candidate.schema';

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c1',
    url: 'https://example.com/file.zip',
    source: 'dom',
    mediaType: 'archive',
    confidence: 50,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Candidate;
}

function expectRejected(fn: () => void): void {
  expect(fn).toThrow(NovaExtensionError);
  try {
    fn();
  } catch (error) {
    expect((error as NovaExtensionError).code).toBe('VALIDATION_FAILED');
  }
}

describe('assertHandoffPayloadBudget', () => {
  it('accepts a single well-formed candidate', () => {
    expect(() => assertHandoffPayloadBudget([candidate()])).not.toThrow();
  });

  it('rejects an empty handoff', () => {
    expectRejected(() => assertHandoffPayloadBudget([]));
  });

  it('rejects more than the maximum candidates', () => {
    const many = Array.from({ length: MAX_HANDOFF_CANDIDATES + 1 }, (_, i) => candidate({ id: `c${i}` }));
    expectRejected(() => assertHandoffPayloadBudget(many));
  });

  it('rejects an over-long candidate URL', () => {
    const url = `https://example.com/${'a'.repeat(MAX_CANDIDATE_URL_CHARS)}`;
    expectRejected(() => assertHandoffPayloadBudget([candidate({ url })]));
  });

  it('rejects too many variants', () => {
    const variants = Array.from({ length: MAX_CANDIDATE_VARIANTS + 1 }, (_, i) => ({ url: `https://example.com/v${i}.ts` }));
    expectRejected(() => assertHandoffPayloadBudget([candidate({ variants } as Partial<Candidate>)]));
  });

  it('rejects too many subtitle tracks', () => {
    const subtitles = Array.from({ length: MAX_CANDIDATE_SUBTITLES + 1 }, (_, i) => ({ url: `https://example.com/s${i}.vtt` }));
    expectRejected(() => assertHandoffPayloadBudget([candidate({ subtitles } as Partial<Candidate>)]));
  });

  it('rejects a payload that exceeds the byte budget', () => {
    const huge = candidate({ metadata: { blob: 'x'.repeat(1_600_000) } });
    expectRejected(() => assertHandoffPayloadBudget([huge]));
  });
});
