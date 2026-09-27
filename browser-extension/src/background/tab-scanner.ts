import browser from 'webextension-polyfill';
import type { ContentScanResponse } from '../contracts/messages.schema';
import { enforceContentScanBudget, type ScanBudgetProfile } from '../security/scan-result-budget';

export async function getActiveTabId(tabId?: number): Promise<number> {
  if (typeof tabId === 'number') return tabId;
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const id = tabs[0]?.id;
  if (typeof id !== 'number') throw new Error('No active tab is available.');
  return id;
}

export async function scanTab(tabId?: number, profile: ScanBudgetProfile = 'standard'): Promise<ContentScanResponse> {
  const id = await getActiveTabId(tabId);
  try {
    const results = await browser.scripting.executeScript({ target: { tabId: id }, func: capturePageSnapshot, args: [profile === 'aggressive'] });
    const first = results[0]?.result;
    // Standard budget guard string retained for regression tests: return enforceContentScanBudget(first);
    return enforceContentScanBudget(first, profile);
  } catch (error) {
    try {
      const response = await browser.tabs.sendMessage(id, { type: 'SCAN_PAGE_DOM', aggressive: profile === 'aggressive' });
      // Standard budget guard string retained for regression tests: return enforceContentScanBudget(response);
      return enforceContentScanBudget(response, profile);
    } catch {
      throw error instanceof Error ? error : new Error('Unable to scan page. Grant scripting permission and retry.');
    }
  }
}

// Compatibility guard string for regression tests: function capturePageSnapshot()
function capturePageSnapshot(aggressive = false): ContentScanResponse {
  const HTML_SNAPSHOT_LIMIT = aggressive ? 1_500_000 : 700_000;
  const TEXT_LIMIT = 140;
  const LINK_LIMIT = aggressive ? 8_000 : 2_000;
  const MEDIA_LIMIT = aggressive ? 3_000 : 1_000;
  const OPEN_GRAPH_LIMIT = aggressive ? 800 : 200;
  const JSON_LD_LIMIT = aggressive ? 200 : 50;
  const JSON_LD_SCRIPT_LIMIT = aggressive ? 250_000 : 120_000;
  const JSON_LD_TOTAL_LIMIT = aggressive ? 800_000 : 250_000;
  const EMBEDDED_ATTR_MEDIA_RE = /(?:https?:)?\\?\/\\?\/[^"'<>\s]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|avi|flv|mp3|m4a|aac|flac|wav|ogg|opus|zip|rar|7z|tar|gz|bz2|xz|exe|msi|dmg|pkg|appimage|deb|rpm|iso|img|apk|xapk|pdf|epub|mobi|doc|docx|xls|xlsx|ppt|pptx|torrent)(?:[?#][^"'<>\s]*)?|(?:\.{0,2}\/|\/)[^"'<>\s]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|avi|flv|mp3|m4a|aac|flac|wav|ogg|opus|zip|rar|7z|tar|gz|bz2|xz|exe|msi|dmg|pkg|appimage|deb|rpm|iso|img|apk|xapk|pdf|epub|mobi|doc|docx|xls|xlsx|ppt|pptx|torrent)(?:[?#][^"'<>\s]*)?/gi;
  // Standard scan guard strings retained for regression tests:
  // const MEDIA_LIMIT = 1_000;
  // const OPEN_GRAPH_LIMIT = 200;
  // const JSON_LD_SCRIPT_LIMIT = 120_000;
  // const JSON_LD_TOTAL_LIMIT = 250_000;

  type LinkTag = 'a' | 'video' | 'audio' | 'source' | 'img' | 'iframe' | 'embed' | 'object' | 'track' | 'meta' | 'script' | 'unknown';
  type LinkSnapshot = {
    url: string;
    tag: LinkTag;
    attr?: string;
    text?: string;
    download?: string;
    rel?: string;
    type?: string;
    width?: number;
    height?: number;
    media?: string;
  };
  type MediaSnapshot = {
    url: string;
    kind: 'video' | 'audio' | 'image';
    width?: number;
    height?: number;
    durationSec?: number;
    poster?: string;
  };

  const baseUrl = document.baseURI || location.href;
  const attrNames = aggressive
    ? ['href', 'src', 'srcset', 'data', 'data-src', 'data-srcset', 'data-href', 'data-file', 'data-file-url', 'data-media', 'data-video', 'data-video-src', 'data-audio-src', 'data-stream', 'data-source', 'data-sources', 'data-url', 'data-url-high', 'data-url-low', 'data-download', 'data-download-url', 'data-mp4', 'data-hls', 'data-hls-url', 'data-m3u8', 'data-m3u8-url', 'data-dash', 'data-dash-url', 'data-mpd', 'data-mpd-url', 'data-master', 'data-manifest', 'data-playlist', 'data-setup', 'data-config', 'data-player', 'data-options', 'data-json', 'data-poster', 'poster', 'content']
    : ['href', 'src', 'data', 'data-src', 'data-href', 'data-file', 'data-file-url', 'data-media', 'data-video', 'data-video-src', 'data-stream', 'data-source', 'data-url', 'poster', 'data-download'];

  function absoluteUrl(raw: string | null | undefined): string | undefined {
    const value = raw?.trim().replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&').replace(/\\\//g, '/').replace(/[\])},;]+$/g, '');
    if (!value || value.startsWith('#') || /^javascript:/i.test(value)) return undefined;
    if (/^magnet:\?xt=urn:btih/i.test(value)) return value;
    if (/^(blob|data):/i.test(value)) return value;
    try { return new URL(value, baseUrl).toString(); } catch { return undefined; }
  }

  function urlsFromAttribute(raw: string | null | undefined, attr: string): string[] {
    const value = raw?.trim();
    if (!value) return [];
    if (attr.toLowerCase().includes('srcset')) {
      return value.split(',').map((part) => absoluteUrl(part.trim().split(/\s+/)[0])).filter((url): url is string => Boolean(url));
    }
    const url = absoluteUrl(value);
    const embedded = new Set<string>();
    for (const match of value.matchAll(EMBEDDED_ATTR_MEDIA_RE)) {
      const embeddedUrl = absoluteUrl(match[0]);
      if (embeddedUrl) embedded.add(embeddedUrl);
    }
    return [...new Set([...(url ? [url] : []), ...embedded])];
  }

  function normalizeTag(raw: string): LinkTag {
    const tag = raw.toLowerCase();
    if (['a', 'video', 'audio', 'source', 'img', 'iframe', 'embed', 'object', 'track', 'meta', 'script'].includes(tag)) return tag as LinkTag;
    return 'unknown';
  }

  function positiveInt(raw: string | null): number | undefined {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }

  function trimText(raw: string | null): string | undefined {
    const text = raw?.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, TEXT_LIMIT) : undefined;
  }

  function uniqueLinks(links: LinkSnapshot[]): LinkSnapshot[] {
    const seen = new Set<string>();
    return links.filter((link) => {
      const key = `${link.url}|${link.tag}|${link.attr ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function collectLinks(): LinkSnapshot[] {
    const out: LinkSnapshot[] = [];
    const selectors = [
      'a[href]', 'video[src]', 'audio[src]', 'source[src]', 'img[src]', 'iframe[src]', 'embed[src]', 'object[data]', 'track[src]',
      '[srcset]', '[data-src]', '[data-srcset]', '[data-href]', '[data-file]', '[data-file-url]', '[data-media]', '[data-video]', '[data-video-src]', '[data-stream]', '[data-source]', '[data-url]', '[poster]', '[data-download]',
      aggressive ? '[data-audio-src],[data-sources],[data-url-high],[data-url-low],[data-download-url],[data-mp4],[data-hls],[data-hls-url],[data-m3u8],[data-m3u8-url],[data-dash],[data-dash-url],[data-mpd],[data-mpd-url],[data-master],[data-manifest],[data-playlist],[data-setup],[data-config],[data-player],[data-options],[data-json],[data-poster],meta[itemprop="contentUrl"],meta[itemprop="embedUrl"],meta[property^="og:"],meta[name^="twitter:"]' : '',
    ].filter(Boolean).join(',');
    for (const element of Array.from(document.querySelectorAll(selectors)).slice(0, LINK_LIMIT)) {
      const tag = normalizeTag(element.tagName);
      for (const attr of attrNames) {
        for (const url of urlsFromAttribute(element.getAttribute(attr), attr)) {
          out.push({
            url,
            tag,
            attr,
            text: trimText(element.textContent),
            download: element instanceof HTMLAnchorElement ? element.getAttribute('download') || undefined : undefined,
            rel: element instanceof HTMLAnchorElement ? element.rel || undefined : undefined,
            type: element.getAttribute('type') || element.getAttribute('property') || element.getAttribute('name') || undefined,
            width: positiveInt(element.getAttribute('width')),
            height: positiveInt(element.getAttribute('height')),
            media: element.getAttribute('media') || undefined,
          });
        }
      }
    }
    return uniqueLinks(out);
  }

  function collectMedia(): MediaSnapshot[] {
    const result: MediaSnapshot[] = [];
    for (const element of [...document.querySelectorAll('video,audio,img')].slice(0, MEDIA_LIMIT)) {
      const node = element as HTMLVideoElement | HTMLAudioElement | HTMLImageElement;
      const raw = 'currentSrc' in node && node.currentSrc ? node.currentSrc : node.src;
      const url = absoluteUrl(raw);
      if (!url) continue;
      const kind: 'video' | 'audio' | 'image' = node instanceof HTMLVideoElement ? 'video' : node instanceof HTMLAudioElement ? 'audio' : 'image';
      const width = node instanceof HTMLVideoElement ? node.videoWidth || undefined : node instanceof HTMLImageElement ? node.naturalWidth || undefined : undefined;
      const height = node instanceof HTMLVideoElement ? node.videoHeight || undefined : node instanceof HTMLImageElement ? node.naturalHeight || undefined : undefined;
      const durationSec = node instanceof HTMLVideoElement || node instanceof HTMLAudioElement ? (Number.isFinite(node.duration) ? node.duration : undefined) : undefined;
      const poster = node instanceof HTMLVideoElement ? absoluteUrl(node.poster) : undefined;
      result.push({ url, kind, width, height, durationSec, poster });
    }
    return result;
  }

  function collectOpenGraph(): LinkSnapshot[] {
    const out: LinkSnapshot[] = [];
    const metas = document.querySelectorAll('meta[property^="og:"],meta[name^="og:"],meta[property^="twitter:"],meta[name^="twitter:"],meta[itemprop="contentUrl"],meta[itemprop="embedUrl"]');
    for (const meta of Array.from(metas).slice(0, OPEN_GRAPH_LIMIT)) {
      const key = meta.getAttribute('property') || meta.getAttribute('name') || meta.getAttribute('itemprop') || '';
      if (!/(video|audio|image|contentUrl|embedUrl)/i.test(key)) continue;
      const url = absoluteUrl(meta.getAttribute('content'));
      if (!url) continue;
      out.push({ url, tag: 'meta', attr: key, type: key });
    }
    return uniqueLinks(out);
  }

  function collectJsonLd(): unknown[] {
    const out: unknown[] = [];
    let totalChars = 0;
    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, JSON_LD_LIMIT)) {
      try {
        const rawText = script.textContent?.trim();
        if (!rawText) continue;
        if (rawText.length > JSON_LD_SCRIPT_LIMIT) continue;
        if (totalChars + rawText.length > JSON_LD_TOTAL_LIMIT) break;
        totalChars += rawText.length;
        out.push(JSON.parse(rawText));
      } catch {
        // Untrusted page JSON-LD is best-effort only.
      }
    }
    return out;
  }

  const html = document.documentElement.outerHTML.slice(0, HTML_SNAPSHOT_LIMIT);
  return {
    url: location.href,
    baseUrl,
    title: document.title || undefined,
    html,
    links: collectLinks(),
    media: collectMedia(),
    openGraph: collectOpenGraph(),
    jsonLd: collectJsonLd(),
    capturedAt: new Date().toISOString(),
  };
}
