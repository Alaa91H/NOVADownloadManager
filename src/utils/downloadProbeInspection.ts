export interface DownloadProbeInspectionInput {
  url: string;
  finalUrl?: string;
  contentType?: string;
  resumable: boolean;
  digestSha256?: string;
  httpStatus?: number;
  linkMirrors?: string[];
}

export interface DownloadProbeInspection {
  sourceOrigin?: string;
  finalOrigin?: string;
  redirected: boolean;
  contentType?: string;
  resumable: boolean;
  digestSha256?: string;
  httpStatus?: number;
  mirrorCount: number;
}

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const SHA256_HEX = /^[a-f0-9]{64}$/i;

/**
 * Returns an origin only, never credentials, paths, queries, or fragments.
 * Probe endpoints can resolve signed URLs, so the Add Download dialog must not
 * surface a full redirected URL back into the DOM or tooltips.
 */
export function sanitizeProbeOrigin(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    const parsed = new URL(value);
    return HTTP_PROTOCOLS.has(parsed.protocol) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function normalizeContentType(value?: string): string | undefined {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeSha256(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && SHA256_HEX.test(normalized) ? normalized : undefined;
}

/**
 * Converts a daemon probe response into a compact, presentation-safe summary.
 * All rendered values are protocol data rather than translated UI prose.
 */
export function summarizeDownloadProbe(input: DownloadProbeInspectionInput): DownloadProbeInspection {
  const sourceOrigin = sanitizeProbeOrigin(input.url);
  const finalOrigin = sanitizeProbeOrigin(input.finalUrl);

  return {
    sourceOrigin,
    finalOrigin,
    redirected: Boolean(sourceOrigin && finalOrigin && sourceOrigin !== finalOrigin),
    contentType: normalizeContentType(input.contentType),
    resumable: input.resumable,
    digestSha256: normalizeSha256(input.digestSha256),
    httpStatus:
      typeof input.httpStatus === 'number' && Number.isInteger(input.httpStatus) && input.httpStatus >= 100
        ? input.httpStatus
        : undefined,
    mirrorCount: input.linkMirrors?.filter((mirror) => Boolean(sanitizeProbeOrigin(mirror))).length ?? 0,
  };
}

export function shouldShowDownloadProbeInspection(
  inspection: DownloadProbeInspection | null,
  infoFetched: boolean,
  isFetchingInfo: boolean,
): inspection is DownloadProbeInspection {
  return inspection !== null && infoFetched && !isFetchingInfo;
}

export function abbreviateSha256(value: string, visibleCharacters = 12): string {
  if (visibleCharacters < 4 || value.length <= visibleCharacters) return value;
  return `${value.slice(0, visibleCharacters)}…`;
}
