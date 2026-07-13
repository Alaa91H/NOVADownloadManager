import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const PROTOCOL = 'https';
const DAILYMOTION_HOSTS: ReadonlyArray<string> = ['www.dailymotion.com', 'dailymotion.com', 'geo.dailymotion.com', 'www.dailymotion.cloud'];
const DAILYMOTION_CDN = ['*.dmcdn.net', '*.dailymotion.com'] as const;

export class DailymotionAdapter extends PlatformAdapter {
  readonly id = 'dailymotion';
  readonly name = 'Dailymotion';
  override readonly hosts = DAILYMOTION_HOSTS;
  override readonly cdnPatterns = DAILYMOTION_CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromOpenGraph(content.openGraph, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const videoRe = /https:\/\/[^\s"'<>]*?dmcdn\.net[^\s"'<>]*?\.(?:mp4|m3u8)[^\s"'<>]*/gi;
    const videoIdRe = /dailymotion\.com\/(?:video|embed\/video)\/([a-zA-Z0-9]+)/gi;
    const playerRe = /player\.dailymotion\.com\/(?:video|embed)\/([a-zA-Z0-9]+)/gi;

    for (const m of html.matchAll(videoRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 18, metadata: { source: 'dmcdn' } });
    }
    for (const m of html.matchAll(videoIdRe)) {
      if (results.some((r) => r.metadata?.videoId === m[1])) continue;
      const vid = m[1];
      if (vid) results.push({ url: `${PROTOCOL}://www.dailymotion.com/video/${vid}`, type: 'video', confidenceDelta: 25, metadata: { source: 'dailymotion-id', videoId: vid } });
    }
    for (const m of html.matchAll(playerRe)) {
      if (results.some((r) => r.metadata?.videoId === m[1])) continue;
      const vid = m[1];
      if (vid) results.push({ url: `${PROTOCOL}://www.dailymotion.com/video/${vid}`, type: 'video', confidenceDelta: 25, metadata: { source: 'dailymotion-player', videoId: vid } });
    }

    const xdmRe = /"url":"(https:\\\/\\\/[^"]+?dmcdn\.net[^"]+?)"/g;
    for (const m of html.matchAll(xdmRe)) {
      const url = m[1]?.replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
      if (url) results.push({ url, type: 'video', confidenceDelta: 20, metadata: { source: 'xdm-json' } });
    }
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (hostname.endsWith('dmcdn.net')) {
          results.push({ url: link.url, type: /\.(mp4|m3u8)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 18, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromOpenGraph(og: ContentScanResponse['openGraph'], results: PlatformMediaResult[]): void {
    if (!og) return;
    for (const entry of og) {
      if (entry.attr?.includes('og:video') || entry.attr?.includes('og:image') || entry.attr?.includes('twitter:player')) {
        results.push({ url: entry.url, type: 'video', confidenceDelta: 20, metadata: { source: 'og', property: entry.attr } });
      }
    }
  }

  adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/dmcdn\.net/.test(url)) {
      if (/\.mp4/i.test(url)) return Math.max(candidate.confidence, 60);
      if (/\.m3u8/i.test(url)) return Math.max(candidate.confidence, 55);
      return Math.max(candidate.confidence, 35);
    }
    if (/dailymotion\.com\/video/.test(url)) return Math.max(candidate.confidence, 55);
    return candidate.confidence + 5;
  }
}
