import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const HOSTS: ReadonlyArray<string> = ['www.tumblr.com', 'tumblr.com'];
const CDN: ReadonlyArray<string> = ['*.tumblr.com', '*.media.tumblr.com', '*.static.tumblr.com', '*.vtt.tumblr.com'];

export class TumblrAdapter extends PlatformAdapter {
  readonly id = 'tumblr';
  readonly name = 'Tumblr';
  override readonly hosts = HOSTS;
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const mp4Re = /https:\/\/[^\s"'<>]*?media\.tumblr\.com[^\s"'<>]*?\.mp4[^\s"'<>]*/gi;
    const m3u8Re = /https:\/\/[^\s"'<>]*?vtt\.tumblr\.com[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const imageRe = /https:\/\/[^\s"'<>]*?(?:media|static)\.tumblr\.com[^\s"'<>]*?\.(?:jpg|png|gif|webp)[^\s"'<>]*/gi;
    const audioRe = /https:\/\/[^\s"'<>]*?(?:media|static)\.tumblr\.com[^\s"'<>]*?\.(?:mp3|ogg|m4a|flac)[^\s"'<>]*/gi;

    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 20, metadata: { source: 'tumblr-video' } });
    for (const m of html.matchAll(m3u8Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 18, metadata: { source: 'tumblr-hls' } });
    for (const m of html.matchAll(imageRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 12, metadata: { source: 'tumblr-image' } });
    for (const m of html.matchAll(audioRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'audio', confidenceDelta: 18, metadata: { source: 'tumblr-audio' } });
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (this.cdnPatterns.some((p) => hostname.endsWith(p.slice(1)))) {
          const ext = link.url.split('?')[0]?.toLowerCase();
          const type = /\.mp4/i.test(ext ?? '') ? 'video' : /\.(mp3|ogg|m4a)/i.test(ext ?? '') ? 'audio' : 'image';
          results.push({ url: link.url, type, confidenceDelta: 15, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/media\.tumblr\.com/.test(url)) {
      if (/\.mp4/i.test(url)) return Math.max(candidate.confidence, 60);
      if (/\.(mp3|ogg|m4a)/i.test(url)) return Math.max(candidate.confidence, 55);
      if (/\.(jpg|png|gif|webp)/i.test(url)) return Math.max(candidate.confidence, 40);
      return Math.max(candidate.confidence, 35);
    }
    if (/vtt\.tumblr\.com/.test(url) && /\.m3u8/i.test(url)) return Math.max(candidate.confidence, 55);
    return candidate.confidence + 5;
  }
}
