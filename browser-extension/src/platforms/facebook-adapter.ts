import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const FB_HOSTS: ReadonlyArray<string> = ['www.facebook.com', 'facebook.com', 'm.facebook.com', 'fb.watch', 'www.fb.watch'];
const FB_CDN = ['*.fbcdn.net', '*.facebook.com', '*.fbsbx.com'] as const;

export class FacebookAdapter extends PlatformAdapter {
  readonly id = 'facebook';
  readonly name = 'Facebook';
  override readonly hosts = FB_HOSTS;
  override readonly cdnPatterns = FB_CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromOpenGraph(content.openGraph, results);
    this.extractFromJsonLd(content.jsonLd, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const videoRe = /https:\/\/(?:video|scontent)[^'"\s<>]*?\.(?:fbcdn|fbsbx)\.net[^\s"'<>]*?videoplayback[^\s"'<>]*/gi;
    const dashRe = /https:\/\/[^\s"'<>]*?\.(?:fbcdn|fbsbx)\.net[^\s"'<>]*?\.mpd[^\s"'<>]*/gi;
    const mp4Re = /https:\/\/[^\s"'<>]*?\.(?:fbcdn|fbsbx)\.net[^\s"'<>]*?\.mp4[^\s"'<>]*/gi;
    for (const m of html.matchAll(mp4Re)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 15, metadata: { source: 'html-video' } });
    }
    for (const m of html.matchAll(dashRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/dash+xml', confidenceDelta: 18, metadata: { source: 'html-dash' } });
    }
    for (const m of html.matchAll(videoRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 20, metadata: { source: 'html-playback' } });
    }
    const imageRe = /https:\/\/[^\s"'<>]*?\.(?:fbcdn|fbsbx)\.net[^\s"'<>]*?\.(?:jpg|png|webp)[^\s"'<>]*/gi;
    for (const m of html.matchAll(imageRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 10, metadata: { source: 'html-image' } });
    }
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (hostname.endsWith('fbcdn.net') || hostname.endsWith('fbsbx.com')) {
          results.push({ url: link.url, type: /\.(mp4|m3u8|mpd)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 15, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromOpenGraph(og: ContentScanResponse['openGraph'], results: PlatformMediaResult[]): void {
    if (!og) return;
    for (const entry of og) {
      if (entry.attr?.includes('og:video') || entry.attr?.includes('og:image') || entry.attr?.includes('og:audio')) {
        results.push({ url: entry.url, type: entry.attr?.includes('video') ? 'video' : entry.attr?.includes('audio') ? 'audio' : 'image', confidenceDelta: 20, metadata: { source: 'og', property: entry.attr } });
      }
    }
  }

  private extractFromJsonLd(jsonLd: ContentScanResponse['jsonLd'], results: PlatformMediaResult[]): void {
    if (!jsonLd) return;
    for (const entry of jsonLd) {
      if (typeof entry !== 'object' || !entry) continue;
      const obj = entry as Record<string, unknown>;
      if (String(obj['@type'] ?? '').includes('VideoObject')) {
        const url = obj.contentUrl ?? obj.embedUrl ?? obj.url;
        if (url && typeof url === 'string') {
          results.push({ url, type: 'video', confidenceDelta: 25, metadata: { source: 'jsonld-video' } });
        }
      }
    }
  }

  adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/fbcdn\.net|fbsbx\.com/.test(url)) {
      if (/videoplayback|\.mp4/i.test(url)) return Math.max(candidate.confidence, 55);
      if (/\.mpd/i.test(url)) return Math.max(candidate.confidence, 50);
      return Math.max(candidate.confidence, 35);
    }
    return candidate.confidence + 5;
  }
}
