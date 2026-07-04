import type { Candidate } from '../contracts/candidate.schema';
import { AdmExtensionError } from '../core/error-classification';

export type HandoffPolicyDecision = {
  allowed: boolean;
  reason?: string;
  repairHint?: string;
  scheme?: string;
};

const BLOCKED_SCHEMES = new Set(['blob:', 'data:', 'javascript:', 'about:', 'chrome:', 'chrome-extension:', 'moz-extension:', 'edge:', 'file:']);
const ALLOWED_NETWORK_SCHEMES = new Set(['http:', 'https:']);

export function handoffPolicyDecision(candidate: Candidate): HandoffPolicyDecision {
  const rawUrl = candidate.finalUrl ?? candidate.url;
  if (/^magnet:\?xt=urn:btih/i.test(rawUrl)) {
    return candidate.mediaType === 'magnet'
      ? { allowed: true, scheme: 'magnet:' }
      : {
          allowed: false,
          reason: 'Magnet URLs must be classified as magnet candidates before handoff.',
          repairHint: 'Rescan the page or use the Send torrent/magnet context menu action.',
          scheme: 'magnet:',
        };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      allowed: false,
      reason: 'Candidate URL is not an absolute handoff URL.',
      repairHint: 'Use a page scan or context menu action that can resolve the URL first.',
    };
  }

  if (ALLOWED_NETWORK_SCHEMES.has(parsed.protocol)) return { allowed: true, scheme: parsed.protocol };

  if (BLOCKED_SCHEMES.has(parsed.protocol)) {
    return {
      allowed: false,
      reason: `${parsed.protocol} URLs are browser-local or ephemeral and cannot be handed off directly to ADM.`,
      repairHint: 'Use page extraction or refresh-address support when ADM exposes it for this site.',
      scheme: parsed.protocol,
    };
  }

  return {
    allowed: false,
    reason: `Unsupported candidate URL scheme: ${parsed.protocol}`,
    repairHint: 'Only http(s) download URLs and magnet links can be handed off directly.',
    scheme: parsed.protocol,
  };
}

export function assertCandidateHandoffAllowed(candidate: Candidate): void {
  const decision = handoffPolicyDecision(candidate);
  if (decision.allowed) return;
  throw new AdmExtensionError({
    code: 'VALIDATION_FAILED',
    message: decision.reason ?? 'Candidate is not valid for ADM handoff.',
    retryable: false,
    repairHint: decision.repairHint,
    details: {
      candidateId: candidate.id,
      source: candidate.source,
      mediaType: candidate.mediaType,
      scheme: decision.scheme,
    },
  });
}
