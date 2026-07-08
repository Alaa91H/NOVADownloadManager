import { hlsManifestEvidence } from '../pipeline/evidence';
import { Parser as M3u8Parser } from 'm3u8-parser';
import { Candidate, VariantSchema } from '../contracts/candidate.schema';
import { CaptureContext } from './capture-context';
import { CapturePlugin } from './capture-plugin';
import { collectEmbeddedMediaUrls } from './embedded-media-capture';
import { detectDrmIndicatorsFromManifestText, drmInfoFromIndicators } from '../security/drm-guard';

const HLS_RE = /https?:\/\/[^"'\s<]+\.m3u8(?:\?[^"'\s<]*)?/gi;

export function parseHlsManifestText(text: string, manifestUrl: string): Pick<Candidate, 'variants' | 'subtitles' | 'durationSec' | 'drm'> {
  try {
    const parser = new M3u8Parser({ url: manifestUrl });
    parser.push(text);
    parser.end();
    const manifest = parser.manifest;
    const variants = (manifest.playlists ?? []).map((playlist) => {
      const width = playlist.attributes?.RESOLUTION?.width;
      const height = playlist.attributes?.RESOLUTION?.height;
      return VariantSchema.parse({
        url: new URL(playlist.uri ?? manifestUrl, manifestUrl).toString(),
        width: typeof width === 'number' && width > 0 ? width : undefined,
        height: typeof height === 'number' && height > 0 ? height : undefined,
        bandwidth: playlist.attributes?.BANDWIDTH,
        codecs: playlist.attributes?.CODECS,
        label: typeof height === 'number' && height > 0 ? `${height}p` : undefined,
        mimeType: 'application/vnd.apple.mpegurl',
      });
    });
    const subtitles = collectM3u8Subtitles(manifest.mediaGroups, manifestUrl);
    const durationSec = (manifest.segments ?? []).reduce((sum, segment) => sum + (segment.duration ?? 0), 0);
    const out: Pick<Candidate, 'variants' | 'subtitles' | 'durationSec' | 'drm'> = { variants, subtitles };
    if (durationSec > 0) out.durationSec = durationSec;
    const drm = drmInfoFromIndicators(detectDrmIndicatorsFromManifestText(text, 'hls'), 'hls-manifest');
    if (drm) out.drm = drm;
    if (variants.length > 0 || subtitles.length > 0 || durationSec > 0) return out;
  } catch {
    // Fallback below keeps tests and unusual manifests robust.
  }
  return parseHlsManifestTextFallback(text, manifestUrl);
}

function collectM3u8Subtitles(mediaGroups: unknown, manifestUrl: string): NonNullable<Candidate['subtitles']> {
  const out: NonNullable<Candidate['subtitles']> = [];
  if (!mediaGroups || typeof mediaGroups !== 'object') return out;
  const subtitles = (mediaGroups as Record<string, unknown>).SUBTITLES;
  if (!subtitles || typeof subtitles !== 'object') return out;
  for (const group of Object.values(subtitles as Record<string, unknown>)) {
    if (!group || typeof group !== 'object') continue;
    for (const [label, item] of Object.entries(group as Record<string, unknown>)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const uri = typeof record.uri === 'string' ? record.uri : undefined;
      if (!uri) continue;
      out.push({ url: new URL(uri, manifestUrl).toString(), language: typeof record.language === 'string' ? record.language : undefined, label, format: 'webvtt' });
    }
  }
  return out;
}

function parseHlsManifestTextFallback(text: string, manifestUrl: string): Pick<Candidate, 'variants' | 'subtitles' | 'durationSec' | 'drm'> {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const variants: Candidate['variants'] = [];
  const subtitles: Candidate['subtitles'] = [];
  let durationSec = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseM3uAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      const next = lines.slice(i + 1).find((candidate) => candidate && !candidate.startsWith('#'));
      if (next) {
        const parts = String(attrs.RESOLUTION ?? '').split('x');
        const rawWidth = Number(parts[0] ?? Number.NaN);
        const rawHeight = Number(parts[1] ?? Number.NaN);
        const width = Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : undefined;
        const height = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : undefined;
        variants.push(VariantSchema.parse({
          url: new URL(next, manifestUrl).toString(),
          width,
          height,
          bandwidth: Number(attrs.BANDWIDTH) || undefined,
          codecs: typeof attrs.CODECS === 'string' ? attrs.CODECS : undefined,
          label: height ? `${height}p` : undefined,
          mimeType: 'application/vnd.apple.mpegurl',
        }));
      }
    }
    if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=SUBTITLES')) {
      const attrs = parseM3uAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (typeof attrs.URI === 'string') subtitles.push({ url: new URL(attrs.URI, manifestUrl).toString(), language: String(attrs.LANGUAGE ?? '') || undefined, label: String(attrs.NAME ?? '') || undefined, format: 'webvtt' });
    }
    if (line.startsWith('#EXTINF:')) durationSec += Number(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
  }
  const out: Pick<Candidate, 'variants' | 'subtitles' | 'durationSec' | 'drm'> = { variants, subtitles };
  if (durationSec > 0) out.durationSec = durationSec;
  const drm = drmInfoFromIndicators(detectDrmIndicatorsFromManifestText(text, 'hls'), 'hls-manifest');
  if (drm) out.drm = drm;
  return out;
}

function parseM3uAttributes(input: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const part of input.match(/(?:[^,"]+|"[^"]*")+/g) ?? []) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim().replace(/^"|"$/g, '');
    out[key] = /^\d+$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

export class HlsManifestCapturePlugin implements CapturePlugin {
  id = 'hls-capture';
  name = 'HlsManifestCapturePlugin';
  requiredPermissions: string[] = [];
  supportedBrowsers = ['chrome', 'edge', 'firefox'] as const;

  async isEnabled(context: CaptureContext): Promise<boolean> {
    return Boolean((context.content?.links.length ?? 0) > 0 || (context.html ?? context.content?.html));
  }

  async capture(context: CaptureContext): Promise<Candidate[]> {
    const html = context.html ?? context.content?.html ?? '';
    const base = context.pageUrl ?? context.content?.baseUrl ?? context.content?.url;
    const now = context.now ?? new Date().toISOString();
    const urls = new Set<string>();
    for (const match of html.matchAll(HLS_RE)) urls.add(match[0]);
    for (const url of collectEmbeddedMediaUrls(html, base)) if (/\.m3u8(?:$|[?#])/i.test(url)) urls.add(url);
    for (const link of context.content?.links ?? []) {
      if (/\.m3u8(?:$|[?#])/i.test(link.url) || link.type === 'application/vnd.apple.mpegurl') urls.add(link.url);
    }
    return [...urls].map((url): Candidate => ({
      id: crypto.randomUUID(),
      url,
      pageUrl: context.pageUrl ?? context.content?.url,
      source: 'hls-manifest',
      mediaType: 'manifest',
      mimeType: 'application/vnd.apple.mpegurl',
      extension: 'm3u8',
      confidence: 0,
      createdAt: now,
      evidence: [hlsManifestEvidence()],
    }));
  }
}
