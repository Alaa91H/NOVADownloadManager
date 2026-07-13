import { IDEMPOTENCY_SCHEMA_VERSION } from '../contracts/limits';
import { Candidate } from '../contracts/candidate.schema';
import { normalizeUrl } from '../utils/url';

type CanonicalCandidate = {
  url: string;
  finalUrl?: string;
  pageUrl?: string;
  mediaType: Candidate['mediaType'];
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  variants?: Array<{ url: string; width?: number; height?: number; bandwidth?: number; codecs?: string; label?: string }>;
};

function canonicalCandidate(candidate: Candidate): CanonicalCandidate {
  return {
    url: normalizeUrl(candidate.url),
    finalUrl: candidate.finalUrl ? normalizeUrl(candidate.finalUrl) : undefined,
    pageUrl: candidate.pageUrl ? normalizeUrl(candidate.pageUrl) : undefined,
    mediaType: candidate.mediaType,
    mimeType: candidate.mimeType,
    filename: candidate.filename,
    sizeBytes: candidate.sizeBytes,
    width: candidate.width,
    height: candidate.height,
    durationSec: candidate.durationSec,
    variants: candidate.variants
      ?.slice(0, 25)
      .map((variant) => ({
        url: normalizeUrl(variant.url),
        width: variant.width,
        height: variant.height,
        bandwidth: variant.bandwidth,
        codecs: variant.codecs,
        label: variant.label,
      }))
      .sort((a, b) => [a.url, a.width ?? 0, a.height ?? 0, a.bandwidth ?? 0, a.codecs ?? '', a.label ?? ''].join('|').localeCompare([b.url, b.width ?? 0, b.height ?? 0, b.bandwidth ?? 0, b.codecs ?? '', b.label ?? ''].join('|'))),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export async function idempotencyKeyFor(candidates: Candidate[]): Promise<string> {
  const canonical = candidates.map(canonicalCandidate).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  const text = `nova-extension-idempotency-v${IDEMPOTENCY_SCHEMA_VERSION}
${stableStringify(canonical)}`;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
