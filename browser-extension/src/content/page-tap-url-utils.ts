import type { Initiator, MediaHint, StreamMetadata } from './page-tap-constants';
import {
  MAX_EMIT_URL_CHARS,
  EMIT_DEDUPE_TTL_MS,
  EMIT_DEDUPE_MAX,
  MAX_EMITS_PER_MINUTE,
  TORRENT_MAGNET_RE,
  STREAM_URL_FAST_RE,
  SMART_STREAM_URL_RE,
  MEDIA_EXTENSIONS,
  YOUTUBE_ITAG_QUALITY,
} from './page-tap-constants';

const emitDedupeCache = new Map<string, number>();
let emitWindowStartedAt = Date.now();
let emitWindowCount = 0;

export function resolveCandidateUrl(raw: string): string | undefined {
  if (!raw || raw.length > MAX_EMIT_URL_CHARS) return undefined;
  if (TORRENT_MAGNET_RE.test(raw)) return raw;
  if (/^(blob|data|javascript|file):/i.test(raw)) return undefined;
  try {
    return new URL(raw, location.href).href;
  } catch {
    return undefined;
  }
}

export function isLikelyInterestingUrl(raw?: string | null, mimeHint?: string | null): boolean {
  if (!raw || raw.length > MAX_EMIT_URL_CHARS) return false;
  if (mimeHint && mediaHintFromMime(normaliseMime(mimeHint))) return true;
  return STREAM_URL_FAST_RE.test(raw);
}

export function canEmit(url: string, initiator: Initiator): boolean {
  const now = Date.now();
  if (now - emitWindowStartedAt >= 60_000) {
    emitWindowStartedAt = now;
    emitWindowCount = 0;
  }
  if (emitWindowCount >= MAX_EMITS_PER_MINUTE) return false;

  const key = `${initiator}:${url}`;
  const previous = emitDedupeCache.get(key);
  if (previous !== undefined && now - previous < EMIT_DEDUPE_TTL_MS) return false;
  emitDedupeCache.set(key, now);
  emitWindowCount += 1;

  if (emitDedupeCache.size > EMIT_DEDUPE_MAX) {
    for (const [cachedKey, seenAt] of emitDedupeCache) {
      if (now - seenAt > EMIT_DEDUPE_TTL_MS) emitDedupeCache.delete(cachedKey);
      if (emitDedupeCache.size <= EMIT_DEDUPE_MAX) break;
    }
  }
  return true;
}

export function extensionOf(url: string): string | undefined {
  if (url.startsWith('magnet:?')) return 'magnet';
  try {
    const p = new URL(url).pathname;
    const m = /\.([a-z0-9]{1,10})$/i.exec(p);
    return m?.[1]?.toLowerCase();
  } catch {
    const m = /\.([a-z0-9]{1,10})(?:$|[?#])/i.exec(url);
    return m?.[1]?.toLowerCase();
  }
}

export function numberFromParam(value?: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function normaliseMime(value?: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value).split(';', 1)[0]?.trim().toLowerCase() || undefined;
  } catch {
    return value.split(';', 1)[0]?.trim().toLowerCase() || undefined;
  }
}

export function extensionFromMime(mime?: string): string | undefined {
  if (!mime) return undefined;
  if (mime.includes('mpegurl')) return 'm3u8';
  if (mime.includes('dash+xml')) return 'mpd';
  if (mime === 'video/mp4') return 'mp4';
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/quicktime') return 'mov';
  if (mime === 'audio/mp4' || mime === 'audio/x-m4a') return 'm4a';
  if (mime === 'audio/webm') return 'webm';
  if (mime === 'audio/mpeg') return 'mp3';
  return undefined;
}

export function mediaHintFromMime(mime?: string): MediaHint | undefined {
  if (!mime) return undefined;
  if (mime.includes('mpegurl') || mime.includes('dash+xml')) return 'manifest';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return undefined;
}

export function readStreamMetadata(
  url: string,
  headerMime?: string | null,
  headerLength?: string | null,
): StreamMetadata {
  try {
    const parsed = new URL(url, location.href);
    const mime =
      normaliseMime(parsed.searchParams.get('mime')) ??
      normaliseMime(parsed.searchParams.get('type')) ??
      normaliseMime(headerMime);
    const itag = parsed.searchParams.get('itag') ?? undefined;
    const mapped = itag ? YOUTUBE_ITAG_QUALITY[itag] : undefined;
    const sizeBytes =
      numberFromParam(parsed.searchParams.get('clen')) ?? numberFromParam(headerLength);
    const durationSec = numberFromParam(parsed.searchParams.get('dur'));
    const bitrate =
      numberFromParam(parsed.searchParams.get('bitrate')) ??
      numberFromParam(parsed.searchParams.get('btr'));
    const qualityLabel =
      parsed.searchParams.get('quality_label') ??
      parsed.searchParams.get('quality') ??
      mapped?.qualityLabel;
    const width = numberFromParam(parsed.searchParams.get('width')) ?? mapped?.width;
    const height = numberFromParam(parsed.searchParams.get('height')) ?? mapped?.height;
    const extensionHint = extensionOf(url) ?? extensionFromMime(mime) ?? mapped?.extensionHint;
    const mediaHint =
      mediaHintFromMime(mime) ?? mapped?.mediaHint ?? mediaHintOf(url, extensionHint);
    return {
      mimeHint: mime,
      extensionHint,
      mediaHint,
      sizeBytes,
      width,
      height,
      bitrate,
      durationSec,
      qualityLabel: qualityLabel ?? (height ? `${height}p` : undefined),
      itag,
    };
  } catch {
    const mime = normaliseMime(headerMime);
    const extensionHint = extensionOf(url) ?? extensionFromMime(mime);
    return {
      mimeHint: mime,
      extensionHint,
      mediaHint: mediaHintFromMime(mime) ?? mediaHintOf(url, extensionHint),
      sizeBytes: numberFromParam(headerLength),
    };
  }
}

export function isSmartStreamUrl(url: string, mimeHint?: string | null): boolean {
  const mime = normaliseMime(mimeHint);
  if (
    mime &&
    (mime.startsWith('video/') ||
      mime.startsWith('audio/') ||
      mime.includes('mpegurl') ||
      mime.includes('dash+xml'))
  )
    return true;
  return SMART_STREAM_URL_RE.test(url);
}

export function isDownloadableUrl(url: string, mimeHint?: string | null): boolean {
  if (TORRENT_MAGNET_RE.test(url)) return true;
  if (/^(blob|data|javascript|file):/i.test(url)) return false;
  try {
    const u = new URL(url, location.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (isSmartStreamUrl(u.href, mimeHint)) return true;
    const ext = extensionOf(u.href);
    return ext !== undefined && MEDIA_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

export function mediaHintOf(url: string, ext?: string, mimeHint?: string): MediaHint {
  const fromMime = mediaHintFromMime(mimeHint);
  if (fromMime) return fromMime;
  const e = ext ?? extensionOf(url) ?? '';
  if (['m3u8', 'mpd'].includes(e)) return 'manifest';
  if (
    [
      'mp4',
      'm4v',
      'webm',
      'mkv',
      'mov',
      'avi',
      'flv',
      '3gp',
      '3g2',
      'ts',
      'm2ts',
      'mpeg',
      'mpg',
      'ogv',
    ].includes(e)
  )
    return 'video';
  if (['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'aiff'].includes(e))
    return 'audio';
  if (['pdf', 'epub', 'mobi', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(e))
    return 'document';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'cab', 'iso', 'img'].includes(e))
    return 'archive';
  if (['exe', 'msi', 'dmg', 'pkg', 'appimage', 'deb', 'rpm', 'apk', 'xapk', 'crx'].includes(e))
    return 'other';
  if (['torrent'].includes(e) || TORRENT_MAGNET_RE.test(url)) return 'torrent';
  if (isSmartStreamUrl(url, mimeHint)) {
    if (/mime=audio(?:%2[fF]|\/)|type=audio/i.test(url)) return 'audio';
    if (/(?:\.m3u8|\.mpd)(?:[?#]|$)/i.test(url)) return 'manifest';
    return 'video';
  }
  return 'other';
}
