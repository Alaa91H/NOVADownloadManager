import { Candidate } from '../contracts/candidate.schema';
import { filenameFromContentDisposition, filenameFromUrl } from './filename-extractor';
import { sizeFromHeaders } from './size-detector';
import { classifyCandidate } from './classifier';
import { normalizeCandidate } from './normalizer';
import { CandidateScorer } from './scorer';
// Enrichment stage order: normalize -> derive filename/mime/size from headers ->
// classify media type -> score confidence. Each stage builds on the previous one.
export class MetadataEnricher {
  private scorer = new CandidateScorer();

  enrich(candidate: Candidate): Candidate {
    let next = normalizeCandidate(candidate);
    next = {
      ...next,
      filename: next.filename ?? filenameFromContentDisposition(next.headers?.contentDisposition) ?? filenameFromUrl(next.finalUrl ?? next.url),
      mimeType: next.mimeType ?? next.headers?.contentType,
      sizeBytes: next.sizeBytes ?? sizeFromHeaders(next.headers),
    };
    next = classifyCandidate(next);
    return { ...next, confidence: this.scorer.score(next), updatedAt: new Date().toISOString() };
  }
}
