export type ManifestVariant = {
  url: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  codecs?: string;
  mimeType?: string;
  label?: string;
};

export type ManifestResult = {
  variants: ManifestVariant[];
  subtitles?: { url: string; language?: string }[];
};

const HLS_EXTENSIONS = /\.m3u8/i;
const DASH_EXTENSIONS = /\.mpd/i;

function absoluteUrl(relative: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(relative)) return relative;
  try { return new URL(relative, baseUrl).toString(); } catch { return relative; }
}

function singleVariant(baseUrl: string): ManifestVariant {
  return { url: baseUrl, label: 'original' };
}

const manifestCache = new Map<string, ManifestResult>();

const CACHE_TTL = 30_000;

function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const entry = manifestCache.get(key);
  if (entry && 'variants' in entry) {
    const cached = entry as unknown as { _ts: number; data: T };
    if (Date.now() - cached._ts < CACHE_TTL) return Promise.resolve(cached.data);
  }
  return fn().then((data) => {
    manifestCache.set(key, { ...data, _ts: Date.now() } as unknown as ManifestResult);
    return data;
  });
}

export async function resolveHlsManifest(manifestUrl: string): Promise<ManifestResult> {
  return cached(manifestUrl, () => resolveHlsManifestUncached(manifestUrl));
}

async function resolveHlsManifestUncached(manifestUrl: string): Promise<ManifestResult> {
  const variants: ManifestVariant[] = [];
  const subtitles: { url: string; language?: string }[] = [];

  const response = await fetch(manifestUrl, {
    signal: AbortSignal.timeout(8000),
    headers: { 'Accept': 'application/vnd.apple.mpegurl,*/*' },
  });
  if (!response.ok) return { variants: [singleVariant(manifestUrl)] };
  const resolvedUrl = response.url;
  const text = await response.text();

  let bandwidthRef: number | undefined;
  let codecsRef: string | undefined;
  let resolutionRef: string | undefined;
  let frameRateRef: string | undefined;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
      bandwidthRef = undefined;
      codecsRef = undefined;
      resolutionRef = undefined;
      frameRateRef = undefined;
      const params = trimmed.slice('#EXT-X-STREAM-INF:'.length);
      const bwMatch = params.match(/\bBANDWIDTH=(\d+)/i);
      if (bwMatch) bandwidthRef = parseInt(bwMatch[1]!, 10);
      const codecMatch = params.match(/\bCODECS="([^"]+)"/i);
      if (codecMatch) codecsRef = codecMatch[1];
      const resMatch = params.match(/\bRESOLUTION=(\d+)x(\d+)/i);
      if (resMatch) resolutionRef = `${resMatch[1]}x${resMatch[2]}`;
      const frMatch = params.match(/\bFRAME-RATE=([\d.]+)/i);
      if (frMatch) frameRateRef = frMatch[1];
      continue;
    }

    if (trimmed.startsWith('#EXT-X-MEDIA:')) {
      const params = trimmed.slice('#EXT-X-MEDIA:'.length);
      const typeMatch = params.match(/\bTYPE=([A-Z]+)/i);
      const uriMatch = params.match(/\bURI="([^"]+)"/i);
      const langMatch = params.match(/\bLANGUAGE="([^"]+)"/i);
      if (typeMatch?.[1] === 'SUBTITLES' && uriMatch?.[1]) {
        subtitles.push({ url: absoluteUrl(uriMatch[1], resolvedUrl), language: langMatch?.[1] });
      }
      if (typeMatch?.[1] === 'VIDEO' && uriMatch?.[1]) {
        const bw = bandwidthRef;
        variants.push({
          url: absoluteUrl(uriMatch[1], resolvedUrl),
          bandwidth: bw,
          label: `${resolutionRef ?? 'unknown'}${bw ? ` (${Math.round(bw / 1000)}kbps)` : ''}`,
        });
      }
      continue;
    }

    if (!trimmed.startsWith('#') && trimmed.length > 0) {
      if (bandwidthRef !== undefined || resolutionRef !== undefined) {
        const url = absoluteUrl(trimmed, resolvedUrl);
        let width: number | undefined;
        let height: number | undefined;
        if (resolutionRef) {
          const parts = resolutionRef.split('x');
          width = parseInt(parts[0]!, 10);
          height = parseInt(parts[1]!, 10);
        }
        variants.push({
          url,
          width,
          height,
          bandwidth: bandwidthRef,
          codecs: codecsRef,
          mimeType: 'application/vnd.apple.mpegurl',
          label: height ? `${height}p${frameRateRef && parseFloat(frameRateRef) > 30 ? '60' : ''}` : undefined,
        });
      }
      bandwidthRef = undefined;
      codecsRef = undefined;
      resolutionRef = undefined;
      frameRateRef = undefined;
    }
  }

  if (variants.length === 0) {
    variants.push(singleVariant(resolvedUrl));
  }

  return { variants, subtitles: subtitles.length > 0 ? subtitles : undefined };
}

export async function resolveDashManifest(manifestUrl: string): Promise<ManifestResult> {
  return cached(manifestUrl, () => resolveDashManifestUncached(manifestUrl));
}

async function resolveDashManifestUncached(manifestUrl: string): Promise<ManifestResult> {
  const variants: ManifestVariant[] = [];

  const response = await fetch(manifestUrl, {
    signal: AbortSignal.timeout(8000),
    headers: { 'Accept': 'application/dash+xml,*/*' },
  });
  if (!response.ok) return { variants: [singleVariant(manifestUrl)] };
  const resolvedUrl = response.url;
  const text = await response.text();

  const adaptationSets = text.match(/<AdaptationSet[^>]*>[\s\S]*?<\/AdaptationSet>/gi) ?? [];
  for (const aset of adaptationSets) {
    const mimeType = aset.match(/\bmimeType="([^"]+)"/i)?.[1];
    const contentType = aset.match(/\bcontentType="([^"]+)"/i)?.[1];
    if (contentType !== 'video' && contentType !== 'audio' && !mimeType?.startsWith('video') && !mimeType?.startsWith('audio')) continue;
    const reps = aset.match(/<Representation[^>]*>[\s\S]*?<\/Representation>/gi) ?? [];
    for (const rep of reps) {
      const bwMatch = rep.match(/\bbandwidth="(\d+)"/i);
      const widthMatch = rep.match(/\bwidth="(\d+)"/i);
      const heightMatch = rep.match(/\bheight="(\d+)"/i);
      const codecMatch = rep.match(/\bcodecs="([^"]+)"/i);
      const idMatch = rep.match(/\bid="([^"]+)"/i);
      const baseUrlMatch = rep.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i);

      if (!baseUrlMatch?.[1] && !/<SegmentList[^>]*>/.test(rep)) continue;

      const baseUrl = baseUrlMatch?.[1] ?? '';
      const url = baseUrl ? absoluteUrl(baseUrl.trim(), resolvedUrl) : undefined;
      const bandwidth = bwMatch ? parseInt(bwMatch[1]!, 10) : undefined;
      const width = widthMatch ? parseInt(widthMatch[1]!, 10) : undefined;
      const height = heightMatch ? parseInt(heightMatch[1]!, 10) : undefined;
      const codecs = codecMatch?.[1];
      const id = idMatch?.[1];

      if (url && !variants.some((v) => v.url === url)) {
        variants.push({
          url,
          width,
          height,
          bandwidth,
          codecs,
          mimeType: mimeType?.split(';')[0],
          label: id ?? (height ? `${height}p` : undefined),
        });
      }
    }
  }

  if (variants.length === 0) {
    const baseUrls = text.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi) ?? [];
    for (const bu of baseUrls) {
      const url = absoluteUrl(bu.replace(/<\/?BaseURL[^>]*>/gi, '').trim(), resolvedUrl);
      if (!variants.some((v) => v.url === url)) {
        variants.push({ url, mimeType: 'application/dash+xml' });
      }
    }
  }

  if (variants.length === 0) {
    variants.push(singleVariant(resolvedUrl));
  }

  return { variants };
}

export function isHlsUrl(url: string): boolean {
  return HLS_EXTENSIONS.test(url);
}

export function isDashUrl(url: string): boolean {
  return DASH_EXTENSIONS.test(url);
}

export function isManifestUrl(url: string): boolean {
  return isHlsUrl(url) || isDashUrl(url);
}

export function clearManifestCache(): void {
  manifestCache.clear();
}
