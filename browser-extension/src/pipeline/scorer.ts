import { Candidate } from '../contracts/candidate.schema';
import { calculateCandidateScore, confidenceLevelOf } from './evidence';

/**
 * CandidateScorer wraps the evidence-based scoring functions.
 * The score is now derived from evidence[] + field bonuses — see evidence.ts.
 * This class is kept for backward-compat (MetadataEnricher calls scorer.score).
 */
export class CandidateScorer {
  score(c: Candidate): number {
    return calculateCandidateScore(c);
  }

  bucket(score: number): 'high' | 'medium' | 'low' | 'hidden' {
    return confidenceLevelOf(score);
  }
}
