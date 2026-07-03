import { Candidate } from '../contracts/candidate.schema';
import { normalizeUrl, extensionOf } from '../utils/url';

export function normalizeCandidate(c: Candidate): Candidate {
  const url = normalizeUrl(c.url);
  const finalUrl = c.finalUrl ? normalizeUrl(c.finalUrl) : undefined;
  return { ...c, url, finalUrl, extension: c.extension ?? extensionOf(finalUrl ?? url) };
}
