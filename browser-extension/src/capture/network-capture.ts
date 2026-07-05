import { Candidate } from '../contracts/candidate.schema';
import { classifyByUrl, mediaTypeFromMime } from '../pipeline/mime-detector';
import { extensionOf } from '../utils/url';
import { CaptureContext, NetworkCaptureEntry } from './capture-context';
import { CapturePlugin } from './capture-plugin';
import { networkHeaderEvidence, contentDispositionEvidence, redirectEvidence } from '../pipeline/evidence';

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
    const filename = entry.headers.contentDisposition.match(/filename[^;=\n]*=([^;\n]*)/i)?.[1]?.trim().replace(/['"]/g, '');
    evidenceItems.push(contentDispositionEvidence(filename));
  }
  if (entry.finalUrl && entry.finalUrl !== entry.url) {
    evidenceItems.push(redirectEvidence(entry.url));
  }
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
    headers: entry.headers,
    confidence: 0,
    createdAt: now,
    evidence: evidenceItems.length > 0 ? evidenceItems : undefined,
  };
}
