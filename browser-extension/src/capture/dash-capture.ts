import { dashManifestEvidence } from '../pipeline/evidence';
import { parse as parseMpd } from 'mpd-parser';
import { Candidate, VariantSchema } from '../contracts/candidate.schema';
import { CaptureContext } from './capture-context';
import { CapturePlugin } from './capture-plugin';
import { collectEmbeddedMediaUrls } from './embedded-media-capture';
import { detectDrmIndicatorsFromManifestText, drmInfoFromIndicators } from '../security/drm-guard';

const DASH_RE = /https?:\/\/[^"'\s<]+\.mpd(?:\?[^"'\s<]*)?/gi;

export function parseDashMpdText(text: string, manifestUrl: string): Pick<Candidate, 'variants' | 'durationSec' | 'drm'> {
  try {
    const parsed = parseMpd(text, { manifestUri: manifestUrl, eventHandler: () => undefined });
    const variants = (parsed.playlists ?? []).map((playlist) => {
      const width = playlist.attributes?.RESOLUTION?.width;
      const height = playlist.attributes?.RESOLUTION?.height;
      const url = playlist.uri ?? playlist.segments?.[0]?.resolvedUri ?? playlist.segments?.[0]?.uri ?? manifestUrl;
      return VariantSchema.parse({
        url: new URL(url, manifestUrl).toString(),
        width: typeof width === 'number' && width > 0 ? width : undefined,
        height: typeof height === 'number' && height > 0 ? height : undefined,
        bandwidth: playlist.attributes?.BANDWIDTH,
        codecs: playlist.attributes?.CODECS,
        label: typeof height === 'number' && height > 0 ? `${height}p` : undefined,
        mimeType: 'application/dash+xml',
      });
    });
    const out: Pick<Candidate, 'variants' | 'durationSec' | 'drm'> = { variants };
    if (typeof parsed.duration === 'number' && parsed.duration > 0) out.durationSec = parsed.duration;
    const drm = drmInfoFromIndicators(detectDrmIndicatorsFromManifestText(text, 'dash'), 'dash-manifest');
    if (drm) out.drm = drm;
    const fallback = parseDashMpdTextFallback(text, manifestUrl);
    if (fallback.variants && fallback.variants.length > 0 && variants.every((variant) => !variant.width && !variant.height)) out.variants = fallback.variants;
    if (out.durationSec === undefined && fallback.durationSec !== undefined) out.durationSec = fallback.durationSec;
    if ((out.variants?.length ?? 0) > 0 || out.durationSec !== undefined) return out;
  } catch {
    // Fallback parser handles minimal MPD snippets and keeps contract tests deterministic.
  }
  return parseDashMpdTextFallback(text, manifestUrl);
}

function parseDashMpdTextFallback(text: string, manifestUrl: string): Pick<Candidate, 'variants' | 'durationSec' | 'drm'> {
  const variants: Candidate['variants'] = [];
  const periodDuration = /mediaPresentationDuration=["']PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?["']/i.exec(text);
  const durationSec = periodDuration ? ((Number(periodDuration[1] ?? 0) * 3600) + (Number(periodDuration[2] ?? 0) * 60) + Number(periodDuration[3] ?? 0)) : undefined;
  const representationRe = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>|<Representation\b([^>]*)\/>/gi;
  for (const match of text.matchAll(representationRe)) {
    const attrs = parseXmlAttrs(match[1] ?? match[3] ?? '');
    const body = match[2] ?? '';
    const baseUrl = /<BaseURL>([^<]+)<\/BaseURL>/i.exec(body)?.[1];
    const width = Number(attrs.width);
    const height = Number(attrs.height);
    const bandwidth = Number(attrs.bandwidth);
    variants.push(VariantSchema.parse({
      url: baseUrl ? new URL(baseUrl, manifestUrl).toString() : manifestUrl,
      width: Number.isFinite(width) && width > 0 ? width : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
      bandwidth: Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : undefined,
      codecs: attrs.codecs,
      label: Number.isFinite(height) && height > 0 ? `${height}p` : undefined,
      mimeType: attrs.mimeType,
    }));
  }
  const out: Pick<Candidate, 'variants' | 'durationSec' | 'drm'> = { variants };
  if (durationSec !== undefined) out.durationSec = durationSec;
  const drm = drmInfoFromIndicators(detectDrmIndicatorsFromManifestText(text, 'dash'), 'dash-manifest');
  if (drm) out.drm = drm;
  return out;
}

function parseXmlAttrs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of input.matchAll(/([\w:-]+)=["']([^"']*)["']/g)) out[match[1] ?? ''] = match[2] ?? '';
  return out;
}

export class DashManifestCapturePlugin implements CapturePlugin {
  id = 'dash-capture';
  name = 'DashManifestCapturePlugin';
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
    for (const match of html.matchAll(DASH_RE)) urls.add(match[0]);
    for (const url of collectEmbeddedMediaUrls(html, base)) if (/\.mpd(?:$|[?#])/i.test(url)) urls.add(url);
    for (const link of context.content?.links ?? []) {
      if (/\.mpd(?:$|[?#])/i.test(link.url) || link.type === 'application/dash+xml') urls.add(link.url);
    }
    return [...urls].map((url): Candidate => ({
      id: crypto.randomUUID(),
      url,
      pageUrl: context.pageUrl ?? context.content?.url,
      source: 'dash-manifest',
      mediaType: 'manifest',
      mimeType: 'application/dash+xml',
      extension: 'mpd',
      confidence: 0,
      createdAt: now,
      evidence: [dashManifestEvidence()],
    }));
  }
}
