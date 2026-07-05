import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const PROTOCOL = 'https';
/** Wistia is used by businesses for video marketing */
const HOSTS: ReadonlyArray<string> = ['www.wistia.com', 'wistia.com', 'fast.wistia.com', 'fast.wistia.net', 'home.wistia.com'];
const CDN: ReadonlyArray<string> = ['*.wistia.com', '*.wistia.net', '*.wistia.io', '*.fast.wistia.com', '*.fast.wistia.net', '*.embed.wistia.com'];

export class WistiaAdapter extends PlatformAdapter {
  readonly id = 'wistia';
  readonly name = 'Wistia';
  override readonly hosts = HOSTS;
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const mp4Re = /https:\/\/[^\s"'<>]*?wistia\.(?:com|net|io)[^\s"'<>]*?\.mp4[^\s"'<>]*/gi;
    const hlsRe = /https:\/\/[^\s"'<>]*?wistia\.(?:com|net|io)[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const imageRe = /https:\/\/[^\s"'<>]*?wistia\.(?:com|net|io)[^\s"'<>]*?\.(?:jpg|png|webp)[^\s"'<>]*/gi;

    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 22, metadata: { source: 'wistia-mp4' } });
    for (const m of html.matchAll(hlsRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 20, metadata: { source: 'wistia-hls' } });
    for (const m of html.matchAll(imageRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 10, metadata: { source: 'wistia-image' } });

    const embedRe = /wistia\.com\/(?:media|embed)\/([a-zA-Z0-9_]+)/gi;
    for (const m of html.matchAll(embedRe)) {
      const mediaId = m[1];
      if (mediaId && !results.some((r) => r.metadata?.mediaId === mediaId)) {
        const mp4Url = `${PROTOCOL}://fast.wistia.com/embed/medias/${mediaId}.m3u8`;
        results.push({ url: mp4Url, type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 25, metadata: { source: 'wistia-embed', mediaId } });
        const mp4Direct = `${PROTOCOL}://fast.wistia.com/embed/medias/${mediaId}/download`;
        results.push({ url: mp4Direct, type: 'video', confidenceDelta: 22, metadata: { source: 'wistia-download', mediaId } });
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
    if (/wistia\.(?:com|net|io)/.test(url)) {
      if (/\.mp4/i.test(url)) return Math.max(candidate.confidence, 65);
      if (/\.m3u8/i.test(url) || /\/embed\/medias\//.test(url)) return Math.max(candidate.confidence, 60);
      return Math.max(candidate.confidence, 40);
    }
    return candidate.confidence + 10;
  }
}
