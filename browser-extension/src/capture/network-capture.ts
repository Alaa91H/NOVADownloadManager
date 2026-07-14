import { Candidate } from '../contracts/candidate.schema';
import { classifyByUrl, mediaTypeFromMime } from '../pipeline/mime-detector';
import { extensionOf } from '../utils/url';
import { CaptureContext, NetworkCaptureEntry } from './capture-context';
import { CapturePlugin } from './capture-plugin';
import { networkHeaderEvidence, contentDispositionEvidence, redirectEvidence } from '../pipeline/evidence';

const CONTENT_RANGE_RE = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i;
const ACCEPT_RANGES_RE = /bytes/i;

function parseContentRange(contentRange?: string): { sizeBytes?: number; start?: number; end?: number } {
  if (!contentRange) return {};
  const match = contentRange.match(CONTENT_RANGE_RE);
  if (!match) return {};
  const start = parseInt(match[1] ?? '', 10);
  const end = parseInt(match[2] ?? '', 10);
  const total = match[3] === '*' ? NaN : parseInt(match[3] ?? '', 10);
  return {
    start: Number.isFinite(start) ? start : undefined,
    end: Number.isFinite(end) ? end : undefined,
    sizeBytes: Number.isFinite(total) && total > 0 ? total : undefined,
  };
}

function parseContentLength(cl?: string): number | undefined {
  if (!cl) return undefined;
  const n = parseInt(cl, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function extractFilenameFromDisposition(cd?: string): string | undefined {
  if (!cd) return undefined;
  const filenameStar = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;\n]*)/i);
  if (filenameStar?.[1]) {
    const decoded = decodeURIComponent(filenameStar[1].replace(/['"]/g, '').trim());
    if (decoded) return decoded;
  }
  const filenameMatch = cd.match(/filename[^;=\n]*=\s*"?([^;\n"]*)"?/i);
  if (filenameMatch?.[1]) {
    const name = filenameMatch[1].trim().replace(/^['"]|['"]$/g, '');
    if (name) return name;
  }
  return undefined;
}

export class NetworkHeaderCapturePlugin implements CapturePlugin {
  id = 'network-capture';
  name = 'NetworkHeaderCapturePlugin';
  requiredPermissions = ['webRequest'];
  supportedBrowsers = ['chrome', 'edge', 'firefox'] as const;

  async isEnabled(context: CaptureContext): Promise<boolean> {
    return (context.networkEntries?.length ?? 0) > 0;
  }

  async capture(context: CaptureContext): Promise<Candidate[]> {
    return (context.networkEntries ?? []).map((entry) => networkEntryToCandidate(entry, context.now ?? new Date().toISOString()));
  }
}

export function networkEntryToCandidate(entry: NetworkCaptureEntry, now: string): Candidate {
  const mimeType = entry.headers?.contentType;
  const evidenceItems = [];
  if (mimeType || entry.headers?.contentLength) {
    evidenceItems.push(networkHeaderEvidence({ mimeType, contentLength: entry.headers?.contentLength }));
  }
  if (entry.headers?.contentDisposition) {
    const filename = extractFilenameFromDisposition(entry.headers.contentDisposition);
    evidenceItems.push(contentDispositionEvidence(filename));
  }
  if (entry.finalUrl && entry.finalUrl !== entry.url) {
    evidenceItems.push(redirectEvidence(entry.url));
  }

  const sizeFromContentLength = parseContentLength(entry.headers?.contentLength);
  const sizeFromRange = parseContentRange(entry.headers?.contentRange);
  const sizeBytes = sizeFromContentLength ?? sizeFromRange.sizeBytes;
  const filename = extractFilenameFromDisposition(entry.headers?.contentDisposition);
  const acceptRanges = entry.headers?.acceptRanges;
  const isPartial = acceptRanges && ACCEPT_RANGES_RE.test(acceptRanges) && sizeFromRange.start !== undefined;

  return {
    id: crypto.randomUUID(),
    url: entry.url,
    finalUrl: entry.finalUrl,
    pageUrl: entry.pageUrl,
    referrer: entry.referrer,
    source: 'network',
    mediaType: mediaTypeFromMime(mimeType) ?? classifyByUrl(entry.finalUrl ?? entry.url),
    mimeType,
    extension: extensionOf(entry.finalUrl ?? entry.url),
    sizeBytes: isPartial ? sizeFromRange.sizeBytes : sizeBytes,
    filename,
    headers: entry.headers,
    confidence: 0,
    createdAt: now,
    evidence: evidenceItems.length > 0 ? evidenceItems : undefined,
  };
}
