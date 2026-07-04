import type { Candidate } from '../contracts/candidate.schema';
import { classifyByUrl, mediaTypeFromMime } from '../pipeline/mime-detector';
import { extensionOf } from '../utils/url';

export type OverlayScanContentLike = {
  url?: string;
  title?: string;
  media?: Array<{ kind?: string; url?: string; width?: number; height?: number; durationSec?: number }>;
  openGraph?: Array<{ type?: string; tag?: string; attr?: string; url?: string }>;
  links?: Array<{ url?: string; tag?: string; attr?: string; type?: string }>;
  jsonLd?: unknown[];
};

const SMART_VIDEO_PAGE_MEDIA_TYPES = new Set<Candidate['mediaType']>(['video', 'manifest']);
const SMART_VIDEO_EXTENSION_RE = /^(?:mp4|m4v|webm|mkv|mov|avi|flv|mpeg|mpg|3gp|3g2|ogv|ts|m2ts|m3u8|m3u|mpd)$/i;
const SMART_VIDEO_URL_RE = /(?:\.m3u8|\.mpd|\.mp4|\.m4v|\.webm|\.mkv|\.mov)(?:[?#]|$)|\/videoplayback\b|mime=video%2f|mime=video\/|type=video/i;
const SMART_VIDEO_NOISE_URL_RE = /(?:ytimg\.com|ggpht\.com|googleusercontent\.com\/.*(?:avatar|photo)|\/api\/stats|\/ptracking|\/log_event|\/generate_204|doubleclick\.net|googleads|\/pagead\/|\/favicon|favicon\.|sprite|storyboard|thumbnail|thumb|hqdefault|maxresdefault|mqdefault|sddefault|vi_webp\/|\/vi\/|\.css(?:[?#]|$)|\.js(?:[?#]|$)|\.mjs(?:[?#]|$)|\.map(?:[?#]|$)|\.woff2?(?:[?#]|$)|\.ttf(?:[?#]|$)|\.ico(?:[?#]|$)|\.svg(?:[?#]|$)|\.png(?:[?#]|$)|\.jpe?g(?:[?#]|$)|\.webp(?:[?#]|$)|\.gif(?:[?#]|$))/i;

type SmartVideoProfile = { width?: number; height?: number; extension?: string; mimeType?: string };

const YOUTUBE_ITAG_VIDEO_PROFILES: Record<string, SmartVideoProfile> = {
  '18': { width: 640, height: 360, extension: 'mp4', mimeType: 'video/mp4' },
  '22': { width: 1280, height: 720, extension: 'mp4', mimeType: 'video/mp4' },
  '37': { width: 1920, height: 1080, extension: 'mp4', mimeType: 'video/mp4' },
  '38': { width: 4096, height: 3072, extension: 'mp4', mimeType: 'video/mp4' },
  '133': { width: 426, height: 240, extension: 'mp4', mimeType: 'video/mp4' },
  '134': { width: 640, height: 360, extension: 'mp4', mimeType: 'video/mp4' },
  '135': { width: 854, height: 480, extension: 'mp4', mimeType: 'video/mp4' },
  '136': { width: 1280, height: 720, extension: 'mp4', mimeType: 'video/mp4' },
  '137': { width: 1920, height: 1080, extension: 'mp4', mimeType: 'video/mp4' },
  '160': { width: 256, height: 144, extension: 'mp4', mimeType: 'video/mp4' },
  '242': { width: 426, height: 240, extension: 'webm', mimeType: 'video/webm' },
  '243': { width: 640, height: 360, extension: 'webm', mimeType: 'video/webm' },
  '244': { width: 854, height: 480, extension: 'webm', mimeType: 'video/webm' },
  '247': { width: 1280, height: 720, extension: 'webm', mimeType: 'video/webm' },
  '248': { width: 1920, height: 1080, extension: 'webm', mimeType: 'video/webm' },
  '271': { width: 2560, height: 1440, extension: 'webm', mimeType: 'video/webm' },
  '278': { width: 256, height: 144, extension: 'webm', mimeType: 'video/webm' },
  '313': { width: 3840, height: 2160, extension: 'webm', mimeType: 'video/webm' },
  '394': { width: 256, height: 144, extension: 'mp4', mimeType: 'video/mp4' },
  '395': { width: 426, height: 240, extension: 'mp4', mimeType: 'video/mp4' },
  '396': { width: 640, height: 360, extension: 'mp4', mimeType: 'video/mp4' },
  '397': { width: 854, height: 480, extension: 'mp4', mimeType: 'video/mp4' },
  '398': { width: 1280, height: 720, extension: 'mp4', mimeType: 'video/mp4' },
  '399': { width: 1920, height: 1080, extension: 'mp4', mimeType: 'video/mp4' },
  '400': { width: 2560, height: 1440, extension: 'mp4', mimeType: 'video/mp4' },
  '401': { width: 3840, height: 2160, extension: 'mp4', mimeType: 'video/mp4' },
  '698': { width: 1280, height: 720, extension: 'mp4', mimeType: 'video/mp4' },
  '699': { width: 1920, height: 1080, extension: 'mp4', mimeType: 'video/mp4' },
};

type OverlayFilterReason = 'overlay-disabled' | 'low-confidence' | 'too-small' | 'too-large' | 'blocked-extension' | 'missing-allowlisted-extension' | 'media-type-rejected' | 'smart-video-page-filter';

type OverlayCandidateDecision = {
  accepted: boolean;
  reason?: OverlayFilterReason;
};

type OverlayCandidateAnalysis = {
  accepted: Candidate[];
  filterReasons: Record<string, number>;
};

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

export function liveOverlayCandidateKey(candidate: Candidate): string {
  const url = candidate.finalUrl ?? candidate.url;
  const quality = `${candidate.width ?? ''}x${candidate.height ?? ''}:${candidate.bitrate ?? ''}:${candidate.sizeBytes ?? ''}:${candidate.extension ?? ''}`;
  try {
    const parsed = new URL(url);
    const itag = parsed.searchParams.get('itag');
    const mime = parsed.searchParams.get('mime') ?? candidate.mimeType ?? '';
    const clen = parsed.searchParams.get('clen') ?? '';
    if (itag) return `${parsed.hostname}${parsed.pathname}:itag=${itag}:mime=${mime}:clen=${clen}:q=${quality}`;
    for (const volatile of ['expire', 'ei', 'ip', 'ipbits', 'ms', 'mv', 'mvi', 'pl', 'rn', 'rbuf', 'range', 'ratebypass', 'sig', 'signature', 'lsig', 'n', 'cver', 'cpn']) {
      parsed.searchParams.delete(volatile);
    }
    return `${parsed.toString()}:q=${quality}`;
  } catch {
    return `${url.split(/[?#]/, 1)[0] ?? url}:q=${quality}`;
  }
}

export function mergeLiveOverlayCandidateSet(existing: Candidate[], fresh: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const candidate of [...existing, ...fresh]) {
    const key = liveOverlayCandidateKey(candidate);
    const previous = byKey.get(key);
    if (!previous || smartVideoCompare(candidate, previous) < 0 || candidate.confidence > previous.confidence) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].sort(smartVideoCompare);
}

export function analyzeOverlayCandidates(candidates: Candidate[], settings: { overlay: { enabled: boolean; minConfidence: number; minFileSizeMB: number; maxFileSizeMB: number; extensionsAllowlist: string[]; extensionsBlocklist: string[]; mediaTypes: Candidate['mediaType'][] } }, smartVideoMode = false): OverlayCandidateAnalysis {
  const accepted: Candidate[] = [];
  const filterReasons: Record<string, number> = {};
  for (const candidate of candidates) {
    const decision = overlayCandidateDecision(candidate, settings, smartVideoMode);
    if (decision.accepted) {
      accepted.push(candidate);
    } else if (decision.reason) {
      filterReasons[decision.reason] = (filterReasons[decision.reason] ?? 0) + 1;
    }
  }
  return { accepted, filterReasons };
}

export function overlayCandidateDecision(candidate: Candidate, settings: { overlay: { enabled: boolean; minConfidence: number; minFileSizeMB: number; maxFileSizeMB: number; extensionsAllowlist: string[]; extensionsBlocklist: string[]; mediaTypes: Candidate['mediaType'][] } }, smartVideoMode = false): OverlayCandidateDecision {
  const overlay = settings.overlay;
  if (!overlay.enabled) return { accepted: false, reason: 'overlay-disabled' };
  if (smartVideoMode && !isSmartVideoCandidate(candidate)) return { accepted: false, reason: 'smart-video-page-filter' };
  if (typeof candidate.confidence === 'number' && candidate.confidence < overlay.minConfidence) return { accepted: false, reason: 'low-confidence' };

  const sizeBytes = typeof candidate.sizeBytes === 'number' ? candidate.sizeBytes : undefined;
  const minBytes = overlay.minFileSizeMB > 0 ? overlay.minFileSizeMB * 1024 * 1024 : 0;
  const maxBytes = overlay.maxFileSizeMB > 0 ? overlay.maxFileSizeMB * 1024 * 1024 : 0;
  if (sizeBytes !== undefined && minBytes > 0 && sizeBytes < minBytes) return { accepted: false, reason: 'too-small' };
  if (sizeBytes !== undefined && maxBytes > 0 && sizeBytes > maxBytes) return { accepted: false, reason: 'too-large' };

  const extension = normalizeExtension(candidate.extension ?? extensionOf(candidate.finalUrl ?? candidate.url) ?? extensionOf(candidate.filename ?? ''));
  const allowlist = normalizedExtensionSet(overlay.extensionsAllowlist);
  const blocklist = normalizedExtensionSet(overlay.extensionsBlocklist);
  if (extension && blocklist.has(extension)) return { accepted: false, reason: 'blocked-extension' };
  if (allowlist.size > 0 && (!extension || !allowlist.has(extension))) return { accepted: false, reason: 'missing-allowlisted-extension' };

  const inferredMediaType = candidate.mediaType ?? mediaTypeFromMime(candidate.mimeType) ?? classifyByUrl(candidate.finalUrl ?? candidate.url);
  if (!overlay.mediaTypes.includes(inferredMediaType)) return { accepted: false, reason: 'media-type-rejected' };
  return { accepted: true };
}

export function isSmartVideoPage(content: OverlayScanContentLike, candidates: Candidate[]): boolean {
  const url = content.url ?? '';
  let host = '';
  let path = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.toLowerCase();
  } catch {
    // Non-standard URLs are treated as ordinary pages unless other evidence says video.
  }
  if ((host === 'youtube.com' || host.endsWith('.youtube.com')) && /^\/(watch|shorts|live)(?:\/|$)/.test(path)) return true;
  if ((content.media ?? []).some((item) => item.kind === 'video')) return true;
  if ((content.openGraph ?? []).some((item) => /video/i.test(`${item.type ?? ''} ${item.attr ?? ''}`))) return true;
  if (candidates.some((candidate) => isSmartVideoCandidate(candidate))) return true;
  return false;
}

export function isSmartVideoCandidate(candidate: Candidate): boolean {
  const url = candidate.finalUrl ?? candidate.url;
  const lowerUrl = url.toLowerCase();
  if (SMART_VIDEO_NOISE_URL_RE.test(lowerUrl)) return false;
  if (SMART_VIDEO_PAGE_MEDIA_TYPES.has(candidate.mediaType)) return true;
  const mime = candidate.mimeType?.toLowerCase() ?? candidate.headers?.contentType?.toLowerCase() ?? '';
  if (mime.startsWith('video/') || mime.includes('mpegurl') || mime.includes('dash+xml')) return true;
  const extension = normalizeExtension(candidate.extension ?? extensionOf(url) ?? extensionOf(candidate.filename ?? ''));
  if (extension && SMART_VIDEO_EXTENSION_RE.test(extension)) return true;
  return SMART_VIDEO_URL_RE.test(lowerUrl);
}

export function prepareSmartVideoCandidates(candidates: Candidate[], pageTitle?: string): Candidate[] {
  return dedupeSmartVideoCandidates(expandSmartVideoVariants(candidates).map(enrichSmartVideoCandidateMetadata))
    .sort(smartVideoCompare)
    .map((candidate) => withSmartVideoDisplayName(candidate, pageTitle))
    .map(withSmartVideoStableId);
}

export function buildOverlayScanMessage(total: number, visible: number, overlayFilteredOut: number, nonHandoffable: number, clipped: number, smartVideoMode = false): string | undefined {
  if (visible > 0 && clipped > 0) {
    return smartVideoMode
      ? `${visible} video items are shown. ${clipped} lower-priority video items were hidden by the smart video-page limit.`
      : `${visible} files are shown. ${clipped} extra files were hidden by the picker item limit.`;
  }
  if (visible > 0) return undefined;
  if (total === 0) return undefined;
  if (smartVideoMode && overlayFilteredOut > 0) return 'Video page detected. Non-video assets such as thumbnails, scripts, icons, and tracking URLs were hidden.';
  if (overlayFilteredOut > 0) return 'Files were detected but hidden by overlay filters. Review type, size, extension, or confidence settings.';
  if (nonHandoffable > 0) return 'Files were detected but are not directly handoffable. Blob, data, javascript, or protected URLs are blocked.';
  return 'Files were detected but no selectable item remained after safety checks.';
}

function expandSmartVideoVariants(candidates: Candidate[]): Candidate[] {
  const expanded: Candidate[] = [];
  for (const candidate of candidates) {
    const variants = candidate.variants ?? [];
    if (variants.length === 0) {
      expanded.push(candidate);
      continue;
    }
    for (const [index, variant] of variants.entries()) {
      const durationSec = candidate.durationSec;
      const sizeBytes = estimateSizeFromBitrate(variant.bandwidth, durationSec) ?? candidate.sizeBytes;
      const extension = normalizeExtension(extensionOf(variant.url) ?? extensionFromMime(variant.mimeType) ?? smartVideoDisplayExtension(candidate));
      const isManifestVariant = /(?:mpegurl|dash\+xml)/i.test(variant.mimeType ?? '') || /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(variant.url);
      expanded.push({
        ...candidate,
        id: `${candidate.id}:variant:${index}:${variant.height ?? ''}:${variant.bandwidth ?? ''}`,
        url: variant.url,
        finalUrl: undefined,
        mediaType: isManifestVariant ? 'manifest' : 'video',
        mimeType: variant.mimeType ?? candidate.mimeType,
        extension: extension ?? candidate.extension,
        width: variant.width ?? candidate.width,
        height: variant.height ?? candidate.height,
        bitrate: variant.bandwidth ?? candidate.bitrate,
        codecs: variant.codecs ? [variant.codecs] : candidate.codecs,
        sizeBytes,
        metadata: {
          ...candidate.metadata,
          overlayVariant: true,
          overlayVariantIndex: index,
          overlayVariantLabel: variant.label,
          overlayParentUrl: candidate.url,
          overlayEstimatedSize: sizeBytes !== undefined && candidate.sizeBytes === undefined && variant.bandwidth !== undefined,
        },
      });
    }
  }
  return expanded;
}

function enrichSmartVideoCandidateMetadata(candidate: Candidate): Candidate {
  const url = candidate.finalUrl ?? candidate.url;
  const params = urlSearchParams(url);
  const itag = params.get('itag');
  const itagProfile = itag ? YOUTUBE_ITAG_VIDEO_PROFILES[itag] : undefined;
  const quality = params.get('quality_label') ?? params.get('quality') ?? params.get('size') ?? undefined;
  const parsedQuality = parseQualityLabel(quality);
  const mimeFromUrl = decodeUrlParam(params.get('mime'));
  const width = candidate.width ?? parsedPositiveInteger(params.get('width')) ?? itagProfile?.width ?? parsedQuality?.width;
  const height = candidate.height ?? parsedPositiveInteger(params.get('height')) ?? itagProfile?.height ?? parsedQuality?.height;
  const bitrate = candidate.bitrate ?? parsedPositiveInteger(params.get('bitrate')) ?? parsedPositiveInteger(params.get('bitrate_bps'));
  const headerSize = parseHeaderSize(candidate.headers?.contentLength, candidate.headers?.contentRange);
  const urlSize = parsedPositiveInteger(params.get('clen')) ?? parsedPositiveInteger(params.get('size'));
  const sizeBytes = candidate.sizeBytes ?? headerSize ?? urlSize ?? estimateSizeFromBitrate(bitrate, candidate.durationSec);
  const mimeType = candidate.mimeType ?? mimeFromUrl ?? itagProfile?.mimeType ?? candidate.headers?.contentType;
  const extension = normalizeExtension(candidate.extension ?? extensionOf(url) ?? extensionFromMime(mimeType) ?? itagProfile?.extension ?? smartVideoDisplayExtension({ ...candidate, mimeType }));
  return {
    ...candidate,
    mimeType,
    extension: extension ?? candidate.extension,
    width,
    height,
    bitrate,
    sizeBytes,
    metadata: {
      ...candidate.metadata,
      overlayQualityLabel: height ? `${height}p` : quality,
      overlayEstimatedSize: candidate.sizeBytes === undefined && sizeBytes !== undefined && headerSize === undefined && urlSize === undefined,
    },
  };
}

function dedupeSmartVideoCandidates(candidates: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = smartVideoDedupeKey(candidate);
    const existing = best.get(key);
    if (!existing || smartVideoCompare(candidate, existing) < 0) best.set(key, candidate);
  }
  return [...best.values()];
}

function smartVideoDedupeKey(candidate: Candidate): string {
  const url = candidate.finalUrl ?? candidate.url;
  const qualityKey = `${candidate.width ?? ''}x${candidate.height ?? ''}:${candidate.bitrate ?? ''}:${candidate.sizeBytes ?? ''}:${candidate.extension ?? ''}`;
  try {
    const parsed = new URL(url);
    const itag = parsed.searchParams.get('itag');
    const mime = parsed.searchParams.get('mime') ?? candidate.mimeType ?? '';
    const quality = parsed.searchParams.get('quality') ?? parsed.searchParams.get('quality_label') ?? '';
    if (itag) return `${parsed.hostname}${parsed.pathname}:itag=${itag}:mime=${mime}:q=${quality}:fields=${qualityKey}`;
    for (const volatile of ['expire', 'ei', 'ip', 'ipbits', 'ms', 'mv', 'mvi', 'pl', 'rn', 'rbuf', 'range', 'ratebypass', 'sig', 'signature', 'lsig', 'n', 'cver', 'cpn']) {
      parsed.searchParams.delete(volatile);
    }
    return `${parsed.toString()}:fields=${qualityKey}`;
  } catch {
    return `${url.split(/[?#]/, 1)[0] ?? url}:fields=${qualityKey}`;
  }
}

function smartVideoCompare(a: Candidate, b: Candidate): number {
  const resolutionDiff = resolutionPixels(b) - resolutionPixels(a);
  if (resolutionDiff !== 0) return resolutionDiff;
  const heightDiff = (b.height ?? 0) - (a.height ?? 0);
  if (heightDiff !== 0) return heightDiff;
  const bitrateDiff = (b.bitrate ?? 0) - (a.bitrate ?? 0);
  if (bitrateDiff !== 0) return bitrateDiff;
  const sizeDiff = (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
  if (sizeDiff !== 0) return sizeDiff;
  return smartVideoRank(b) - smartVideoRank(a);
}

function resolutionPixels(candidate: Candidate): number {
  return (candidate.width ?? 0) * (candidate.height ?? 0);
}

function smartVideoRank(candidate: Candidate): number {
  let rank = candidate.confidence;
  if (candidate.mediaType === 'video') rank += 300;
  if (candidate.mediaType === 'manifest') rank += 240;
  if (candidate.source === 'media-element') rank += 90;
  if (candidate.source === 'hls-manifest' || candidate.source === 'dash-manifest') rank += 80;
  if (candidate.width && candidate.height) rank += Math.min(120, Math.round((candidate.width * candidate.height) / 30000));
  if (candidate.bitrate) rank += Math.min(80, Math.round(candidate.bitrate / 100000));
  if (candidate.sizeBytes) rank += Math.min(60, Math.round(candidate.sizeBytes / (20 * 1024 * 1024)));
  return rank;
}

function withSmartVideoStableId(candidate: Candidate): Candidate {
  return { ...candidate, id: `overlay-video-${stableHash(smartVideoDedupeKey(candidate))}` };
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function withSmartVideoDisplayName(candidate: Candidate, pageTitle?: string): Candidate {
  if (candidate.filename) return candidate;
  const cleanTitle = sanitizeVideoTitle(pageTitle);
  if (!cleanTitle) return candidate;
  const extension = smartVideoDisplayExtension(candidate);
  const quality = candidate.height ? ` ${candidate.height}p` : '';
  return {
    ...candidate,
    filename: extension ? `${cleanTitle}${quality}.${extension}` : `${cleanTitle}${quality}`,
    metadata: { ...candidate.metadata, overlaySmartVideoDisplayName: true },
  };
}

function urlSearchParams(url: string): URLSearchParams {
  try {
    return new URL(url).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function decodeUrlParam(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parsedPositiveInteger(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

function parseQualityLabel(value?: string): { width?: number; height?: number } | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  const height = Number(/(?:^|[^0-9])(\d{3,4})p\b/.exec(normalized)?.[1] ?? Number.NaN);
  if (Number.isFinite(height) && height > 0) return { height, width: aspectWidthFromHeight(height) };
  const match = /(\d{3,5})x(\d{3,5})/.exec(normalized);
  if (!match) return undefined;
  const width = Number(match[1]);
  const parsedHeight = Number(match[2]);
  return Number.isFinite(width) && Number.isFinite(parsedHeight) ? { width, height: parsedHeight } : undefined;
}

function aspectWidthFromHeight(height: number): number | undefined {
  return height > 0 ? Math.round((height * 16) / 9) : undefined;
}

function parseHeaderSize(contentLength?: string, contentRange?: string): number | undefined {
  const direct = parsedPositiveInteger(contentLength);
  if (direct !== undefined) return direct;
  const rangeTotal = /\/(\d+)\s*$/.exec(contentRange ?? '')?.[1];
  return parsedPositiveInteger(rangeTotal);
}

function estimateSizeFromBitrate(bitrate?: number, durationSec?: number): number | undefined {
  if (!bitrate || !durationSec || !Number.isFinite(durationSec) || durationSec <= 0) return undefined;
  return Math.max(1, Math.round((bitrate * durationSec) / 8));
}

function extensionFromMime(mimeType?: string): string | undefined {
  const mime = mimeType?.toLowerCase() ?? '';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('matroska')) return 'mkv';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('mpegurl')) return 'm3u8';
  if (mime.includes('dash+xml')) return 'mpd';
  return undefined;
}

function sanitizeVideoTitle(value?: string): string | undefined {
  const clean = value
    ?.replace(/\s+-\s+YouTube$/i, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return clean || undefined;
}

function smartVideoDisplayExtension(candidate: { extension?: string; finalUrl?: string; url: string; filename?: string; mimeType?: string; headers?: { contentType?: string }; mediaType?: Candidate['mediaType'] }): string | undefined {
  const extension = normalizeExtension(candidate.extension ?? extensionOf(candidate.finalUrl ?? candidate.url) ?? extensionOf(candidate.filename ?? ''));
  if (extension && SMART_VIDEO_EXTENSION_RE.test(extension)) return extension === 'm3u' ? 'm3u8' : extension;
  const mime = candidate.mimeType?.toLowerCase() ?? candidate.headers?.contentType?.toLowerCase() ?? '';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mpegurl')) return 'm3u8';
  if (mime.includes('dash+xml')) return 'mpd';
  if (candidate.mediaType === 'manifest') return 'm3u8';
  return candidate.mediaType === 'video' ? 'mp4' : undefined;
}

function normalizeExtension(value?: string): string | undefined {
  const normalized = value?.trim().replace(/^\.+/, '').toLowerCase();
  return normalized || undefined;
}

function normalizedExtensionSet(values: string[]): Set<string> {
  return new Set(values.map((value) => normalizeExtension(value)).filter((value): value is string => Boolean(value)));
}
