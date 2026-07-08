import { Candidate } from '../contracts/candidate.schema';
import { classifyByUrl, mediaTypeFromMime } from '../pipeline/mime-detector';
import { extensionOf } from '../utils/url';
import { CaptureContext, DownloadCaptureEntry } from './capture-context';
import { CapturePlugin } from './capture-plugin';
import { downloadsApiEvidence } from '../pipeline/evidence';

export class DownloadsCapturePlugin implements CapturePlugin {
  id = 'downloads-capture';
  name = 'DownloadsCapturePlugin';
  requiredPermissions = ['downloads'];
  supportedBrowsers = ['chrome', 'edge', 'firefox'] as const;

  async isEnabled(context: CaptureContext): Promise<boolean> {
    return (context.downloadEntries?.length ?? 0) > 0;
  }

  async capture(context: CaptureContext): Promise<Candidate[]> {
    return (context.downloadEntries ?? []).map((entry) => downloadEntryToCandidate(entry, context.now ?? new Date().toISOString()));
  }
}

export function downloadEntryToCandidate(entry: DownloadCaptureEntry, now: string): Candidate {
  const sizeBytes = entry.totalBytes && entry.totalBytes > 0 ? entry.totalBytes : entry.fileSize && entry.fileSize > 0 ? entry.fileSize : undefined;
  return {
    id: crypto.randomUUID(),
    url: entry.url,
    finalUrl: entry.finalUrl,
    referrer: entry.referrer,
    source: 'downloads-api',
    mediaType: mediaTypeFromMime(entry.mime) ?? classifyByUrl(entry.finalUrl ?? entry.url),
    mimeType: entry.mime,
    filename: entry.filename,
    sizeBytes,
    extension: entry.filename ? extensionOf(entry.filename) : extensionOf(entry.finalUrl ?? entry.url),
    confidence: 0,
    createdAt: now,
    evidence: [downloadsApiEvidence({ filename: entry.filename, mime: entry.mime, sizeBytes })],
  };
}
