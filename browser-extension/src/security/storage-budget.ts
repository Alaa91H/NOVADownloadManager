import { Candidate } from '../contracts/candidate.schema';
import {
  MAX_CANDIDATE_CACHE_BYTES_PER_TAB,
  MAX_CANDIDATE_METADATA_BYTES,
  MAX_DIAGNOSTICS_EXPORT_BYTES,
  MAX_SETTINGS_IMPORT_BYTES,
  MAX_SITE_RULES_IMPORT_BYTES,
} from '../contracts/limits';
import { NovaExtensionError } from '../core/error-classification';
import { byteLength } from '../utils/text';

export type StorageBudgetKind = 'candidate-cache' | 'settings-import' | 'site-rules-import' | 'diagnostics-export';

export function jsonBytes(value: unknown): number {
  return byteLength(JSON.stringify(value ?? null));
}

export function storageBudgetFor(kind: StorageBudgetKind): number {
  if (kind === 'candidate-cache') return MAX_CANDIDATE_CACHE_BYTES_PER_TAB;
  if (kind === 'settings-import') return MAX_SETTINGS_IMPORT_BYTES;
  if (kind === 'site-rules-import') return MAX_SITE_RULES_IMPORT_BYTES;
  return MAX_DIAGNOSTICS_EXPORT_BYTES;
}

export function assertStorageBudget(kind: StorageBudgetKind, value: unknown, maxBytes = storageBudgetFor(kind)): void {
  const sizeBytes = jsonBytes(value);
  if (sizeBytes > maxBytes) {
    throw new NovaExtensionError({
      code: 'VALIDATION_FAILED',
      message: `${kind} exceeded the safe local storage budget.`,
      retryable: false,
      repairHint: 'Reduce imported data size or clear local extension data.',
      details: { kind, sizeBytes, maxBytes },
    });
  }
}

function compactMetadata(metadata: Candidate['metadata']): Candidate['metadata'] {
  if (!metadata) return metadata;
  if (jsonBytes(metadata) <= MAX_CANDIDATE_METADATA_BYTES) return metadata;
  return {
    truncated: true,
    reason: 'metadata exceeded extension storage budget',
    originalKeys: Object.keys(metadata).slice(0, 100),
  };
}

export function storageSafeCandidate(candidate: Candidate): Candidate {
  const withCompactMetadata: Candidate = { ...candidate, metadata: compactMetadata(candidate.metadata) };
  if (jsonBytes(withCompactMetadata) <= MAX_CANDIDATE_CACHE_BYTES_PER_TAB) return withCompactMetadata;
  return {
    ...withCompactMetadata,
    variants: withCompactMetadata.variants?.slice(0, 25),
    subtitles: withCompactMetadata.subtitles?.slice(0, 25),
  };
}

export function fitCandidatesWithinStorageBudget(candidates: Candidate[], maxBytes = MAX_CANDIDATE_CACHE_BYTES_PER_TAB): Candidate[] {
  const safe = candidates.map(storageSafeCandidate);
  let runningBytes = 0;
  const accepted: Candidate[] = [];
  for (const candidate of safe) {
    const candidateBytes = jsonBytes(candidate);
    if (runningBytes + candidateBytes > maxBytes) continue;
    accepted.push(candidate);
    runningBytes += candidateBytes;
  }
  return accepted;
}
