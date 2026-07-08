import { Candidate } from '../contracts/candidate.schema';
import { mergeEvidence } from './evidence';
import { normalizeUrl } from '../utils/url';

function candidateKey(c: Candidate): string {
  return [
    normalizeUrl(c.finalUrl ?? c.url),
    c.pageUrl ?? '',
    c.filename ?? '',
    c.sizeBytes ?? '',
    c.mimeType ?? '',
    c.mediaType,
    c.width ?? '',
    c.height ?? '',
  ].join('|');
}

export function dedupeCandidates(input: Candidate[]): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const candidate of input) {
    const key = candidateKey(candidate);
    const prev = map.get(key);
    // mergeEvidence() combines both evidence trails and recalculates confidence.
    map.set(key, prev ? mergeEvidence(prev, candidate) : candidate);
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}
