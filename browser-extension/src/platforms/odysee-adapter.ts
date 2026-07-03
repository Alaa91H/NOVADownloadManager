import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const HOSTS: ReadonlyArray<string> = ['odysee.com', 'www.odysee.com', 'lbry.tv', 'www.lbry.tv', 'open.lbry.com'];
const CDN: ReadonlyArray<string> = ['*.odysee.com', '*.lbry.tv', '*.lbryplayer.xyz', '*.odycdn.com'];

export class OdyseeAdapter extends PlatformAdapter {
  readonly id = 'odysee';
  readonly name = 'Odysee/LBRY';
  override readonly hosts = HOSTS;
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromInitialState(content.html, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const mp4Re = /https:\/\/[^\s"'<>]*?(?:odycdn|lbryplayer|odysee|lbry)\.(?:com|tv|xyz)[^\s"'<>]*?\.(?:mp4|webm)[^\s"'<>]*/gi;
    const m3u8Re = /https:\/\/[^\s"'<>]*?(?:odycdn|lbryplayer|odysee|lbry)\.(?:com|tv|xyz)[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const imageRe = /https:\/\/[^\s"'<>]*?(?:odycdn|lbryplayer|odysee|lbry)\.(?:com|tv|xyz)[^\s"'<>]*?\.(?:jpg|png|webp)[^\s"'<>]*/gi;

    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 20, metadata: { source: 'odysee-video' } });
    for (const m of html.matchAll(m3u8Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 18, metadata: { source: 'odysee-hls' } });
    for (const m of html.matchAll(imageRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 10, metadata: { source: 'odysee-image' } });
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (this.cdnPatterns.some((p) => hostname.endsWith(p.slice(1)))) {
          results.push({ url: link.url, type: /\.(mp4|webm|m3u8)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 15, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromInitialState(html: string, results: PlatformMediaResult[]): void {
    const streamRe = /"streamingUrl"\s*:\s*"([^"]+?)"/gi;
    for (const m of html.matchAll(streamRe)) {
      const url = m[1]?.replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
      if (url && !results.some((r) => r.url === url)) {
        results.push({ url, type: 'video', confidenceDelta: 28, metadata: { source: 'odysee-stream-url' } });
      }
    }
    const srcRe = /(?:src|source|video_url|download_url)\s*:\s*"([^"]+?)"/gi;
    for (const m of html.matchAll(srcRe)) {
      const url = m[1]?.replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
      if (url && /https?:\/\//.test(url) && !results.some((r) => r.url === url)) {
        results.push({ url, type: 'video', confidenceDelta: 25, metadata: { source: 'odysee-source' } });
      }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/odycdn\.com|lbryplayer\.xyz|odysee\.com/.test(url)) {
      if (/\.(mp4|webm)/i.test(url)) return Math.max(candidate.confidence, 65);
      if (/\.m3u8/i.test(url)) return Math.max(candidate.confidence, 60);
      return Math.max(candidate.confidence, 40);
    }
    return candidate.confidence + 5;
  }
}
