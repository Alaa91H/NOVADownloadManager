import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const PROTOCOL = 'https';
const VIMEO_HOSTS: ReadonlyArray<string> = ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'];
const VIMEO_CDN = ['*.vimeocdn.com', '*.akamaized.net'] as const;

export class VimeoAdapter extends PlatformAdapter {
  readonly id = 'vimeo';
  readonly name = 'Vimeo';
  override readonly hosts = VIMEO_HOSTS;
  override readonly cdnPatterns = VIMEO_CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromOpenGraph(content.openGraph, results);
    this.extractFromJsonLd(content.jsonLd, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const m3u8Re = /https:\/\/[^\s"'<>]*?vimeocdn\.net[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const mp4Re = /https:\/\/[^\s"'<>]*?vimeocdn\.net[^\s"'<>]*?\.mp4[^\s"'<>]*/gi;
    const videoIdRe = /vimeo\.com\/(\d+)/g;

    for (const m of html.matchAll(m3u8Re)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 20, metadata: { source: 'vimeo-hls' } });
    }
    for (const m of html.matchAll(mp4Re)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 22, metadata: { source: 'vimeo-mp4' } });
    }
    for (const m of html.matchAll(videoIdRe)) {
      const vid = m[1];
      if (!vid) continue;
      if (results.some((r) => r.metadata?.videoId === vid)) continue;
      results.push({ url: `${PROTOCOL}://vimeo.com/${vid}`, type: 'video', confidenceDelta: 20, metadata: { source: 'vimeo-id', videoId: vid } });
    }

    const playerConfigRe = /https:\/\/player\.vimeo\.com\/video\/(\d+)/gi;
    for (const m of html.matchAll(playerConfigRe)) {
      const vid = m[1];
      if (!vid) continue;
      if (results.some((r) => r.metadata?.videoId === vid)) continue;
      results.push({ url: `${PROTOCOL}://vimeo.com/${vid}`, type: 'video', confidenceDelta: 20, metadata: { source: 'vimeo-player', videoId: vid } });
    }
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (hostname.endsWith('vimeocdn.net')) {
          results.push({ url: link.url, type: /\.(mp4|m3u8)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 18, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromOpenGraph(og: ContentScanResponse['openGraph'], results: PlatformMediaResult[]): void {
    if (!og) return;
    for (const entry of og) {
      if (entry.attr?.includes('og:video') || entry.attr?.includes('og:image') || entry.attr?.includes('twitter:player')) {
        const m = entry.url.match(/vimeo\.com\/(\d+)/);
        const vid = m?.[1] ?? 'unknown';
        results.push({ url: entry.url, type: 'video', confidenceDelta: 20, metadata: { source: 'og', property: entry.attr ?? '', videoId: vid } });
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
        if (url && typeof url === 'string' && url.includes('vimeo')) {
          const m = url.match(/(\d+)/);
          const vid = m?.[1] ?? 'unknown';
          results.push({ url, type: 'video', confidenceDelta: 25, metadata: { source: 'jsonld', videoId: vid, type: String(obj['@type'] ?? '') } });
        }
      }
    }
  }

  adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/vimeocdn\.net/.test(url)) {
      if (/\.mp4/i.test(url)) return Math.max(candidate.confidence, 65);
      if (/\.m3u8/i.test(url)) return Math.max(candidate.confidence, 60);
      return Math.max(candidate.confidence, 40);
    }
    if (/vimeo\.com\/\d+/.test(url)) return Math.max(candidate.confidence, 55);
    return candidate.confidence + 5;
  }
}
