import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const HOSTS: ReadonlyArray<string> = ['www.pinterest.com', 'pinterest.com', 'www.pinterest.ca', 'www.pinterest.co.uk', 'pin.it'];
const CDN: ReadonlyArray<string> = ['*.pinimg.com', '*.pinterest.com'];

export class PinterestAdapter extends PlatformAdapter {
  readonly id = 'pinterest';
  readonly name = 'Pinterest';
  override readonly hosts = HOSTS;
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromResourceData(content.html, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const mp4Re = /https:\/\/[^\s"'<>]*?pinimg\.com[^\s"'<>]*?\.mp4[^\s"'<>]*/gi;
    const hlsRe = /https:\/\/[^\s"'<>]*?pinimg\.com[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const imageRe = /https:\/\/[^\s"'<>]*?pinimg\.com[^\s"'<>]*?\.(?:jpg|png|webp)[^\s"'<>]*/gi;

    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 20, metadata: { source: 'pinimg-video' } });
    for (const m of html.matchAll(hlsRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 18, metadata: { source: 'pinimg-hls' } });
    for (const m of html.matchAll(imageRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 12, metadata: { source: 'pinimg-image' } });
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (hostname.endsWith('pinimg.com')) {
          results.push({ url: link.url, type: /\.(mp4|m3u8)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 15, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromResourceData(html: string, results: PlatformMediaResult[]): void {
    const matches = html.matchAll(/"video_url"\s*:\s*"([^"]+?)"/gi);
    for (const m of matches) {
      const url = m[1]?.replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
      if (url && !results.some((r) => r.url === url)) {
        results.push({ url, type: 'video', confidenceDelta: 25, metadata: { source: 'pinterest-video-url' } });
      }
    }
    const imageMatches = html.matchAll(/"(?:image_original_url|image_url)"\s*:\s*"([^"]+?)"/gi);
    for (const m of imageMatches) {
      const url = m[1]?.replace(/\\\//g, '/');
      if (url && !results.some((r) => r.url === url)) {
        results.push({ url, type: 'image', confidenceDelta: 18, metadata: { source: 'pinterest-image-url' } });
      }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/pinimg\.com/.test(url)) {
      if (/\.mp4/i.test(url)) return Math.max(candidate.confidence, 60);
      return Math.max(candidate.confidence, 40);
    }
    return candidate.confidence + 5;
  }
}
