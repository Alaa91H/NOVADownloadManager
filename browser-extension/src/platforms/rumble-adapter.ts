import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const HOSTS: ReadonlyArray<string> = ['rumble.com', 'www.rumble.com'];
const CDN: ReadonlyArray<string> = ['*.rumble.com', '*.rumbleservice.com'];

export class RumbleAdapter extends PlatformAdapter {
  readonly id = 'rumble';
  readonly name = 'Rumble';
  override readonly hosts = HOSTS;
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromPlayerConfig(content.html, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const mp4Re = /https:\/\/[^\s"'<>]*?rumble\.com[^\s"'<>]*?\.(?:mp4|webm)[^\s"'<>]*/gi;
    const m3u8Re = /https:\/\/[^\s"'<>]*?rumble\.com[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const imageRe = /https:\/\/[^\s"'<>]*?rumble\.com[^\s"'<>]*?\.(?:jpg|png|webp)[^\s"'<>]*/gi;

    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 20, metadata: { source: 'rumble-video' } });
    for (const m of html.matchAll(m3u8Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 20, metadata: { source: 'rumble-hls' } });
    for (const m of html.matchAll(imageRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 10, metadata: { source: 'rumble-image' } });
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (hostname.endsWith('rumble.com')) {
          results.push({ url: link.url, type: /\.(mp4|webm|m3u8)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 15, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromPlayerConfig(html: string, results: PlatformMediaResult[]): void {
    const configRe = /"ua"\s*:\s*\{[^}]+\}/gi;
    const configMatch = html.match(configRe);
    if (!configMatch) return;
    for (const chunk of configMatch) {
      const urlMatches = chunk.matchAll(/"url"\s*:\s*"([^"]+?)"/gi);
      for (const m of urlMatches) {
        const url = m[1]?.replace(/\\\//g, '/');
        if (url && /\.(mp4|m3u8)/i.test(url) && !results.some((r) => r.url === url)) {
          results.push({ url, type: 'video', confidenceDelta: 25, metadata: { source: 'rumble-player-config' } });
        }
      }
    }
    const mp4UrlRe = /"mp4"\s*:\s*"([^"]+?)"/gi;
    for (const m of html.matchAll(mp4UrlRe)) {
      const url = m[1]?.replace(/\\\//g, '/');
      if (url && !results.some((r) => r.url === url)) {
        results.push({ url, type: 'video', confidenceDelta: 28, metadata: { source: 'rumble-mp4-config' } });
      }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/rumble\.com/.test(url)) {
      if (/\.(mp4|webm)/i.test(url)) return Math.max(candidate.confidence, 65);
      if (/\.m3u8/i.test(url)) return Math.max(candidate.confidence, 60);
      return Math.max(candidate.confidence, 35);
    }
    return candidate.confidence + 5;
  }
}
