import type { ContentScanResponse } from '../contracts/messages.schema';
import {
  AGGRESSIVE_MAX_SCAN_HTML_CHARS,
  AGGRESSIVE_MAX_SCAN_JSON_LD_ITEMS,
  AGGRESSIVE_MAX_SCAN_JSON_LD_SCRIPT_CHARS,
  AGGRESSIVE_MAX_SCAN_JSON_LD_TOTAL_CHARS,
  AGGRESSIVE_MAX_SCAN_LINKS,
  AGGRESSIVE_MAX_SCAN_MEDIA,
  AGGRESSIVE_MAX_SCAN_OPEN_GRAPH,
  MAX_SCAN_HTML_CHARS,
  MAX_SCAN_JSON_LD_ITEMS,
  MAX_SCAN_JSON_LD_SCRIPT_CHARS,
  MAX_SCAN_JSON_LD_TOTAL_CHARS,
  MAX_SCAN_LINKS,
  MAX_SCAN_MEDIA,
  MAX_SCAN_OPEN_GRAPH,
} from '../contracts/limits';

type LinkTag =
  | 'a'
  | 'video'
  | 'audio'
  | 'source'
  | 'img'
  | 'iframe'
  | 'embed'
  | 'object'
  | 'track'
  | 'meta'
  | 'script'
  | 'unknown';

const EMBEDDED_ATTR_MEDIA_RE =
  /(?:https?:)?\\?\/\\?\/[^"'<>\s]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|avi|flv|mp3|m4a|aac|flac|wav|ogg|opus|zip|rar|7z|tar|gz|bz2|xz|exe|msi|dmg|pkg|appimage|deb|rpm|iso|img|apk|xapk|pdf|epub|mobi|doc|docx|xls|xlsx|ppt|pptx|torrent)(?:[?#][^"'<>\s]*)?|(?:\.{0,2}\/|\/)[^"'<>\s]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|avi|flv|mp3|m4a|aac|flac|wav|ogg|opus|zip|rar|7z|tar|gz|bz2|xz|exe|msi|dmg|pkg|appimage|deb|rpm|iso|img|apk|xapk|pdf|epub|mobi|doc|docx|xls|xlsx|ppt|pptx|torrent)(?:[?#][^"'<>\s]*)?/gi;

function normalizeTag(value: string): LinkTag {
  const tag = value.toLowerCase();
  return [
    'a',
    'video',
    'audio',
    'source',
    'img',
    'iframe',
    'embed',
    'object',
    'track',
    'meta',
    'script',
  ].includes(tag)
    ? (tag as LinkTag)
    : 'unknown';
}

function absolute(raw: string | null | undefined): string | undefined {
  const value = raw
    ?.trim()
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/[\])},;]+$/g, '');
  if (!value || /^javascript:/i.test(value) || value.startsWith('#')) return undefined;
  try {
    return /^magnet:/i.test(value)
      ? value
      : new URL(value, document.baseURI || location.href).toString();
  } catch {
    return undefined;
  }
}

function embeddedUrlsFromAttribute(value: string): string[] {
  const urls = new Set<string>();
  for (const match of value.matchAll(EMBEDDED_ATTR_MEDIA_RE)) {
    const url = absolute(match[0]);
    if (url) urls.add(url);
  }
  return [...urls];
}

function urlsFromAttribute(raw: string | null | undefined, attr: string): string[] {
  const value = raw?.trim();
  if (!value) return [];
  if (attr.toLowerCase().includes('srcset')) {
    return value
      .split(',')
      .map((part) => absolute(part.trim().split(/\s+/)[0]))
      .filter((url): url is string => Boolean(url));
  }
  const url = absolute(value);
  const embedded = embeddedUrlsFromAttribute(value);
  return [...new Set([...(url ? [url] : []), ...embedded])];
}

function scanPage(aggressive = false): ContentScanResponse {
  const maxHtml = aggressive ? AGGRESSIVE_MAX_SCAN_HTML_CHARS : MAX_SCAN_HTML_CHARS;
  const maxLinks = aggressive ? AGGRESSIVE_MAX_SCAN_LINKS : MAX_SCAN_LINKS;
  const maxMedia = aggressive ? AGGRESSIVE_MAX_SCAN_MEDIA : MAX_SCAN_MEDIA;
  const maxOpenGraph = aggressive ? AGGRESSIVE_MAX_SCAN_OPEN_GRAPH : MAX_SCAN_OPEN_GRAPH;
  const maxJsonLd = aggressive ? AGGRESSIVE_MAX_SCAN_JSON_LD_ITEMS : MAX_SCAN_JSON_LD_ITEMS;
  const maxJsonLdScript = aggressive
    ? AGGRESSIVE_MAX_SCAN_JSON_LD_SCRIPT_CHARS
    : MAX_SCAN_JSON_LD_SCRIPT_CHARS;
  const maxJsonLdTotal = aggressive
    ? AGGRESSIVE_MAX_SCAN_JSON_LD_TOTAL_CHARS
    : MAX_SCAN_JSON_LD_TOTAL_CHARS;
  const html = document.documentElement.outerHTML.slice(0, maxHtml);
  const attrs = aggressive
    ? [
        'href',
        'src',
        'srcset',
        'data',
        'data-src',
        'data-srcset',
        'data-href',
        'data-file',
        'data-file-url',
        'data-media',
        'data-video',
        'data-video-src',
        'data-audio-src',
        'data-stream',
        'data-source',
        'data-sources',
        'data-url',
        'data-url-high',
        'data-url-low',
        'data-download',
        'data-download-url',
        'data-mp4',
        'data-hls',
        'data-hls-url',
        'data-m3u8',
        'data-m3u8-url',
        'data-dash',
        'data-dash-url',
        'data-mpd',
        'data-mpd-url',
        'data-master',
        'data-manifest',
        'data-playlist',
        'data-setup',
        'data-config',
        'data-player',
        'data-options',
        'data-json',
        'data-poster',
        'poster',
        'content',
      ]
    : [
        'href',
        'src',
        'data',
        'data-src',
        'data-href',
        'data-file',
        'data-file-url',
        'data-media',
        'data-video',
        'data-video-src',
        'data-stream',
        'data-source',
        'data-url',
        'poster',
      ];
  const selectors = [
    'a[href]',
    'video[src]',
    'audio[src]',
    'source[src]',
    'img[src]',
    'iframe[src]',
    'embed[src]',
    'object[data]',
    'track[src]',
    '[srcset]',
    '[data-src]',
    '[data-srcset]',
    '[data-href]',
    '[data-file]',
    '[data-file-url]',
    '[data-media]',
    '[data-video]',
    '[data-video-src]',
    '[data-stream]',
    '[data-source]',
    '[data-url]',
    '[poster]',
    aggressive
      ? '[data-audio-src],[data-sources],[data-url-high],[data-url-low],[data-download-url],[data-mp4],[data-hls],[data-hls-url],[data-m3u8],[data-m3u8-url],[data-dash],[data-dash-url],[data-mpd],[data-mpd-url],[data-master],[data-manifest],[data-playlist],[data-setup],[data-config],[data-player],[data-options],[data-json],[data-poster],meta[itemprop="contentUrl"],meta[itemprop="embedUrl"],meta[property^="og:"],meta[name^="twitter:"]'
      : '',
  ]
    .filter(Boolean)
    .join(',');

  const links = [...document.querySelectorAll(selectors)].slice(0, maxLinks).flatMap((element) =>
    attrs.flatMap((attr) =>
      urlsFromAttribute(element.getAttribute(attr), attr).map((url) => ({
        url,
        tag: normalizeTag(element.tagName),
        attr,
        text: element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 140) || undefined,
        type:
          element.getAttribute('type') ||
          element.getAttribute('property') ||
          element.getAttribute('name') ||
          undefined,
      })),
    ),
  );

  const media = [...document.querySelectorAll('video,audio,source[src],img')]
    .slice(0, maxMedia)
    .flatMap((element) => {
      const tag = element.tagName.toLowerCase();
      if (tag === 'source') {
        const src = absolute(element.getAttribute('src') ?? '');
        const parentVideo = (element as HTMLElement).closest('video');
        if (!src) return [];
        return {
          url: src,
          kind: 'video' as const,
          width: parentVideo?.videoWidth || undefined,
          height: parentVideo?.videoHeight || undefined,
          durationSec:
            parentVideo && Number.isFinite(parentVideo.duration) ? parentVideo.duration : undefined,
          poster: undefined,
        };
      }
      const node = element as HTMLVideoElement | HTMLAudioElement | HTMLImageElement;
      const url = absolute('currentSrc' in node && node.currentSrc ? node.currentSrc : node.src);
      const kind: 'video' | 'audio' | 'image' =
        node instanceof HTMLVideoElement
          ? 'video'
          : node instanceof HTMLAudioElement
            ? 'audio'
            : 'image';
      const width =
        node instanceof HTMLVideoElement
          ? node.videoWidth || undefined
          : node instanceof HTMLImageElement
            ? node.naturalWidth || undefined
            : undefined;
      const height =
        node instanceof HTMLVideoElement
          ? node.videoHeight || undefined
          : node instanceof HTMLImageElement
            ? node.naturalHeight || undefined
            : undefined;
      const durationSec =
        node instanceof HTMLVideoElement || node instanceof HTMLAudioElement
          ? Number.isFinite(node.duration)
            ? node.duration
            : undefined
          : undefined;
      const poster = node instanceof HTMLVideoElement ? absolute(node.poster) : undefined;
      if (!url) return [];
      return { url, kind, width, height, durationSec, poster };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const openGraph = [
    ...document.querySelectorAll(
      'meta[property^="og:"],meta[name^="og:"],meta[property^="twitter:"],meta[name^="twitter:"],meta[itemprop="contentUrl"],meta[itemprop="embedUrl"]',
    ),
  ]
    .slice(0, maxOpenGraph)
    .map((meta) => {
      const key =
        meta.getAttribute('property') ||
        meta.getAttribute('name') ||
        meta.getAttribute('itemprop') ||
        '';
      if (!/(video|audio|image|contentUrl|embedUrl)/i.test(key)) return undefined;
      const url = absolute(meta.getAttribute('content'));
      return url ? { url, tag: 'meta' as LinkTag, attr: key, type: key } : undefined;
    })
    .filter((item): item is { url: string; tag: LinkTag; attr: string; type: string } =>
      Boolean(item),
    );

  const jsonLd: unknown[] = [];
  let jsonLdChars = 0;
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(
    0,
    maxJsonLd,
  )) {
    const raw = script.textContent?.trim();
    if (!raw || raw.length > maxJsonLdScript) continue;
    if (jsonLdChars + raw.length > maxJsonLdTotal) break;
    try {
      jsonLd.push(JSON.parse(raw));
      jsonLdChars += raw.length;
    } catch {
      // JSON-LD is untrusted, best-effort metadata only.
    }
  }

  return {
    url: location.href,
    baseUrl: document.baseURI,
    title: document.title || undefined,
    html,
    links,
    media,
    openGraph,
    jsonLd,
    capturedAt: new Date().toISOString(),
  };
}

export { scanPage, normalizeTag, absolute, embeddedUrlsFromAttribute, urlsFromAttribute };
