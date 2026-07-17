import type { Candidate } from '../contracts/candidate.schema';

export function mediaTypeFromPageTapHint(value?: string): Candidate['mediaType'] | undefined {
  if (!value) return undefined;
  if (['video', 'audio', 'image', 'document', 'archive', 'torrent', 'manifest', 'other'].includes(value)) {
    return value as Candidate['mediaType'];
  }
  return undefined;
}

export function buildPageTapFilename(ev: { pageUrl: string; extensionHint?: string; qualityLabel?: string; height?: number; itag?: string }): string | undefined {
  const ext = (ev.extensionHint ?? '').replace(/^\.+/, '').toLowerCase();
  if (!ext) return undefined;
  const quality = ev.qualityLabel ?? (ev.height ? `${ev.height}p` : ev.itag ? `itag-${ev.itag}` : 'stream');
  let title = 'video';
  try {
    const host = new URL(ev.pageUrl).hostname.replace(/^www\./, '');
    title = host || title;
  } catch {
    // keep fallback
  }
  return `${title}-${quality}.${ext}`.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-');
}
