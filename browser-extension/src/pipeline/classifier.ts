import { Candidate } from '../contracts/candidate.schema';
import { classifyByUrl, mediaTypeFromMime } from './mime-detector';

export function classifyCandidate(c: Candidate): Candidate {
  const inferred = mediaTypeFromMime(c.mimeType) ?? classifyByUrl(c.finalUrl ?? c.url);
  return { ...c, mediaType: inferred === 'other' ? c.mediaType : inferred };
}
