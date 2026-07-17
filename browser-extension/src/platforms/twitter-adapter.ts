import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const TWITTER_HOSTS: ReadonlyArray<string> = ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com', 'mobile.twitter.com', 't.co'] as const;
const TWITTER_CDN: ReadonlyArray<string> = ['*.twimg.com'] as const;

const M3U8_RE = /https:\/\/video\.twimg\.com[^\s"'<>]*\.m3u8[^\s"'<>]*/gi;
const MP4_RE = /https:\/\/video\.twimg\.com[^\s"'<>]*\.mp4[^\s"'<>]*/gi;

export class TwitterAdapter extends PlatformAdapter {
  readonly id = 'twitter';
  readonly name = 'Twitter/X';
  override readonly hosts = TWITTER_HOSTS;
  override readonly cdnPatterns = TWITTER_CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromCDNUrls(content.html, results);
    this.extractFromOpenGraph(content.openGraph, results);
    this.extractFromLinks(content.links, results);
    this.extractFromJsonLd(content.jsonLd, results);
    this.extractFromNextData(content.html, results);
    return results;
  }

  private extractFromCDNUrls(html: string, results: PlatformMediaResult[]): void {
    for (const m of html.matchAll(M3U8_RE)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 20, metadata: { source: 'twimg-hls' } });
    }
    for (const m of html.matchAll(MP4_RE)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 25, metadata: { source: 'twimg-mp4' } });
    }
  }

  private extractFromOpenGraph(og: ContentScanResponse['openGraph'], results: PlatformMediaResult[]): void {
    if (!og) return;
    for (const entry of og) {
      if (entry.attr?.includes('twitter:player') || entry.attr?.includes('twitter:image')) {
        results.push({ url: entry.url, type: entry.attr?.includes('image') ? 'image' : 'video', confidenceDelta: 20, metadata: { source: 'twitter-card', property: entry.attr } });
      }
      if (entry.attr?.includes('og:video') || entry.attr?.includes('og:image')) {
        results.push({ url: entry.url, type: entry.attr?.includes('image') ? 'image' : 'video', confidenceDelta: 15, metadata: { source: 'og', property: entry.attr } });
      }
    }
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (hostname.endsWith('twimg.com')) {
          results.push({ url: link.url, type: /\.(mp4|m3u8)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 15, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromJsonLd(jsonLd: ContentScanResponse['jsonLd'], results: PlatformMediaResult[]): void {
    if (!jsonLd) return;
    for (const entry of jsonLd) {
      if (typeof entry !== 'object' || !entry) continue;
      const obj = entry as Record<string, unknown>;
      if (String(obj['@type'] ?? '').includes('VideoObject') || String(obj['@type'] ?? '').includes('MediaObject')) {
        const urls: string[] = [];
        if (typeof obj.contentUrl === 'string') urls.push(obj.contentUrl);
        if (typeof obj.embedUrl === 'string') urls.push(obj.embedUrl);
        if (typeof obj.url === 'string') urls.push(obj.url);
        for (const url of urls) {
          results.push({ url, type: 'video', confidenceDelta: 20, metadata: { source: 'jsonld', type: String(obj['@type']) } });
        }
      }
    }
  }

  private extractFromNextData(html: string, results: PlatformMediaResult[]): void {
    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.+?)<\/script>/s);
    if (!m?.[1]) return;
    try {
      const data = JSON.parse(m[1]);
      this.traverseNextData(data, results, new Set());
    } catch { /* ignore */ }
  }

  private traverseNextData(obj: unknown, results: PlatformMediaResult[], visited: Set<unknown>): void {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
    visited.add(obj);
    if (Array.isArray(obj)) { for (const item of obj) this.traverseNextData(item, results, visited); return; }
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (/video|media|stream/i.test(key) && typeof record[key] === 'object' && record[key]) {
        const media = record[key] as Record<string, unknown>;
        if (typeof media.url === 'string' && /twimg\.com/i.test(media.url)) {
          results.push({
            url: media.url, type: String(media.type ?? '').includes('video') ? 'video' : 'image',
            width: media.width as number | undefined, height: media.height as number | undefined,
            confidenceDelta: 25, metadata: { source: 'next-data', key },
          });
        }
      }
      this.traverseNextData(record[key], results, visited);
    }
  }

  adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/video\.twimg\.com/.test(url)) {
      if (/\.mp4/i.test(url)) return Math.max(candidate.confidence, 65);
      if (/\.m3u8/i.test(url)) return Math.max(candidate.confidence, 60);
      return Math.max(candidate.confidence, 45);
    }
    if (/pbs\.twimg\.com/.test(url)) return Math.max(candidate.confidence, 40);
    return candidate.confidence + 5;
  }
}
