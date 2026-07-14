import { Candidate } from '../contracts/candidate.schema';
import {
  MAX_CANDIDATE_SUBTITLES,
  MAX_CANDIDATE_URL_CHARS,
  MAX_CANDIDATE_VARIANTS,
  MAX_HANDOFF_CANDIDATES,
  MAX_HANDOFF_PAYLOAD_BYTES,
} from '../contracts/limits';
import { byteLength } from '../utils/text';
import { NovaExtensionError } from '../core/error-classification';

function payloadBytes(value: unknown): number {
  return byteLength(JSON.stringify(value));
}

function candidateUrls(candidate: Candidate): string[] {
  return [
    candidate.url,
    candidate.finalUrl,
    candidate.pageUrl,
    candidate.referrer,
    ...(candidate.variants ?? []).map((variant) => variant.url),
    ...(candidate.subtitles ?? []).map((subtitle) => subtitle.url),
  ].filter((value): value is string => typeof value === 'string');
}

export function assertHandoffPayloadBudget(candidates: Candidate[]): void {
  if (candidates.length === 0) {
    throw new NovaExtensionError({
      code: 'VALIDATION_FAILED',
      message: 'No candidates were provided for NOVA handoff.',
      retryable: false,
    });
  }

  if (candidates.length > MAX_HANDOFF_CANDIDATES) {
    throw new NovaExtensionError({
      code: 'VALIDATION_FAILED',
      message: `Too many candidates in one NOVA handoff. Maximum is ${MAX_HANDOFF_CANDIDATES}.`,
      retryable: false,
      repairHint: 'Send a smaller batch.',
    });
  }

  for (const candidate of candidates) {
    for (const url of candidateUrls(candidate)) {
      if (url.length > MAX_CANDIDATE_URL_CHARS) {
        throw new NovaExtensionError({
          code: 'VALIDATION_FAILED',
          message: 'Candidate URL is too large for safe local handoff.',
          retryable: false,
          repairHint: 'Report this issue if it keeps happening.',
        });
      }
    }
    if ((candidate.variants?.length ?? 0) > MAX_CANDIDATE_VARIANTS) {
      throw new NovaExtensionError({
        code: 'VALIDATION_FAILED',
        message: 'Candidate contains too many media variants for one handoff.',
        retryable: false,
      });
    }
    if ((candidate.subtitles?.length ?? 0) > MAX_CANDIDATE_SUBTITLES) {
      throw new NovaExtensionError({
        code: 'VALIDATION_FAILED',
        message: 'Candidate contains too many subtitle tracks for one handoff.',
        retryable: false,
      });
    }
  }

  if (payloadBytes(candidates) > MAX_HANDOFF_PAYLOAD_BYTES) {
    throw new NovaExtensionError({
      code: 'VALIDATION_FAILED',
      message: 'NOVA handoff payload exceeds the safe extension budget.',
      retryable: false,
      repairHint: 'Send fewer candidates or use site rules to narrow capture results.',
    });
  }
}
