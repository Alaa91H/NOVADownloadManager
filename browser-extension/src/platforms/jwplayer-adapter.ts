import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

/** JW Player is embedded across thousands of news/media sites (e.g. BBC, CNN, NBC) */
const CDN: ReadonlyArray<string> = ['*.jwplayer.com', '*.content.jwplatform.com', '*.cdn.jwplayer.com', '*.cloud.jwplayer.com'];

export class JwPlayerAdapter extends PlatformAdapter {
  readonly id = 'jwplayer';
  readonly name = 'JW Player';
  readonly hosts: ReadonlyArray<string> = [];
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const mp4Re = /https:\/\/[^\s"'<>]*?content\.jwplatform\.com[^\s"'<>]*?\.mp4[^\s"'<>]*/gi;
    const m3u8Re = /https:\/\/[^\s"'<>]*?content\.jwplatform\.com[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const jwManifestRe = /https:\/\/cdn\.jwplayer\.com\/manifests\/[^\s"'<>]+/gi;
    const jwFeedRe = /https:\/\/cdn\.jwplayer\.com\/v2\/media\/[^\s"'<>]+/gi;

    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 22, metadata: { source: 'jwplatform-mp4' } });
    for (const m of html.matchAll(m3u8Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 20, metadata: { source: 'jwplatform-hls' } });
    for (const m of html.matchAll(jwManifestRe)) results.push({ url: m[0], type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 18, metadata: { source: 'jwplayer-manifest' } });
    for (const m of html.matchAll(jwFeedRe)) results.push({ url: m[0], type: 'video', confidenceDelta: 16, metadata: { source: 'jwplayer-feed' } });

    const setupRe = /jwplayer\([^)]+\)\.setup\(\s*\{([^}]+)\}/gi;
    for (const m of html.matchAll(setupRe)) {
      const fileMatch = m[1]?.match(/file\s*:\s*['"]([^'"]+?)['"]/i);
      if (fileMatch?.[1]) {
        const url = fileMatch[1].replace(/\\\//g, '/');
        if (!results.some((r) => r.url === url)) {
          results.push({ url, type: 'video', confidenceDelta: 28, metadata: { source: 'jwplayer-setup' } });
        }
      }
    }
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (this.cdnPatterns.some((p) => hostname.endsWith(p.slice(1)))) {
          results.push({ url: link.url, type: /\.(mp4|m3u8)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 18, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/content\.jwplatform\.com/.test(url)) return Math.max(candidate.confidence, 65);
    if (/(?:cdn|cloud)\.jwplayer\.com/.test(url)) return Math.max(candidate.confidence, 55);
    return candidate.confidence + 10;
  }
}
