import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const HOSTS: ReadonlyArray<string> = ['www.linkedin.com', 'linkedin.com'];
const CDN: ReadonlyArray<string> = ['*.licdn.com', '*.linkedin.com'];

export class LinkedInAdapter extends PlatformAdapter {
  readonly id = 'linkedin';
  readonly name = 'LinkedIn';
  override readonly hosts = HOSTS;
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromOpenGraph(content.openGraph, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const mp4Re = /https:\/\/[^\s"'<>]*?licdn\.com[^\s"'<>]*?\.mp4[^\s"'<>]*/gi;
    const m3u8Re = /https:\/\/[^\s"'<>]*?licdn\.com[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const dashRe = /https:\/\/[^\s"'<>]*?licdn\.com[^\s"'<>]*?\.mpd[^\s"'<>]*/gi;
    const imageRe = /https:\/\/[^\s"'<>]*?licdn\.com[^\s"'<>]*?\.(?:jpg|png|webp)[^\s"'<>]*/gi;

    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 20, metadata: { source: 'licdn-mp4' } });
    for (const m of html.matchAll(m3u8Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 20, metadata: { source: 'licdn-hls' } });
    for (const m of html.matchAll(dashRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/dash+xml', confidenceDelta: 20, metadata: { source: 'licdn-dash' } });
    for (const m of html.matchAll(imageRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 10, metadata: { source: 'licdn-image' } });
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (hostname.endsWith('licdn.com')) {
          results.push({ url: link.url, type: /\.(mp4|m3u8|mpd)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 16, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromOpenGraph(og: ContentScanResponse['openGraph'], results: PlatformMediaResult[]): void {
    if (!og) return;
    for (const entry of og) {
      if (entry.attr?.includes('og:video') || entry.attr?.includes('og:image')) {
        results.push({ url: entry.url, type: entry.attr?.includes('image') ? 'image' : 'video', confidenceDelta: 18, metadata: { source: 'og', property: entry.attr } });
      }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/licdn\.com/.test(url)) {
      if (/\.mp4/i.test(url)) return Math.max(candidate.confidence, 60);
      if (/\.(m3u8|mpd)/i.test(url)) return Math.max(candidate.confidence, 55);
      return Math.max(candidate.confidence, 35);
    }
    return candidate.confidence + 5;
  }
}
