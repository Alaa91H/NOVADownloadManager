import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const PROTOCOL = 'https';
/** Kaltura is used by universities and enterprises for video hosting */
const CDN: ReadonlyArray<string> = ['*.kaltura.com', '*.cdn.kaltura.com', '*.kaltura.cdn.cegeka.com'];

export class KalturaAdapter extends PlatformAdapter {
  readonly id = 'kaltura';
  readonly name = 'Kaltura';
  readonly hosts: ReadonlyArray<string> = [];
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const hlsRe = /https:\/\/[^\s"'<>]*?kaltura\.com[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const dashRe = /https:\/\/[^\s"'<>]*?kaltura\.com[^\s"'<>]*?\.mpd[^\s"'<>]*/gi;
    const mp4Re = /https:\/\/[^\s"'<>]*?kaltura\.com[^\s"'<>]*?\.mp4[^\s"'<>]*/gi;
    const thumbRe = /https:\/\/[^\s"'<>]*?kaltura\.com[^\s"'<>]*?\/thumbnail\/[^\s"'<>]*/gi;

    for (const m of html.matchAll(hlsRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 22, metadata: { source: 'kaltura-hls' } });
    for (const m of html.matchAll(dashRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/dash+xml', confidenceDelta: 22, metadata: { source: 'kaltura-dash' } });
    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 20, metadata: { source: 'kaltura-mp4' } });
    for (const m of html.matchAll(thumbRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 8, metadata: { source: 'kaltura-thumb' } });

    const playManifestRe = /https:\/\/[^\s"'<>]*?kaltura\.com[^\s"'<>]*?\/p\/\d+\/sp\/\d+\/playManifest\/[^\s"'<>]+/gi;
    for (const m of html.matchAll(playManifestRe)) {
      const url = m[0].replace(/\\u0026/gi, '&');
      if (!results.some((r) => r.url === url)) {
        results.push({ url, type: 'video', confidenceDelta: 25, metadata: { source: 'kaltura-play-manifest' } });
      }
    }

    const embedRe = /kWidget\.(?:embed|thumb)\s*\([^)]+?partnerId\s*:\s*(\d+)[^)]+?entryId\s*:\s*['"]?([^'"]+?)['"]?/gi;
    for (const m of html.matchAll(embedRe)) {
      const partnerId = m[1];
      const entryId = m[2];
      if (partnerId && entryId) {
        results.push({
          url: `${PROTOCOL}://cdn.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/format/url/protocol/${PROTOCOL}`,
          type: 'video', confidenceDelta: 28, metadata: { source: 'kaltura-embed', partnerId, entryId },
        });
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
          results.push({ url: link.url, type: /\.(mp4|m3u8|mpd)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 18, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/kaltura\.com/.test(url)) {
      if (/playManifest|\.(m3u8|mpd)/i.test(url)) return Math.max(candidate.confidence, 65);
      if (/\.mp4/i.test(url)) return Math.max(candidate.confidence, 60);
      return Math.max(candidate.confidence, 35);
    }
    return candidate.confidence + 10;
  }
}
