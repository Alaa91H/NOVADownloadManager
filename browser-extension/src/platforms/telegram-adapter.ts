import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const HOSTS: ReadonlyArray<string> = ['t.me', 'telegram.me', 'telegram.dog', 'web.telegram.org'];
const CDN: ReadonlyArray<string> = ['*.t.me', '*.telegram.org', '*.cdn-telegram.org'];

export class TelegramAdapter extends PlatformAdapter {
  readonly id = 'telegram';
  readonly name = 'Telegram';
  override readonly hosts = HOSTS;
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const videoRe = /https:\/\/[^\s"'<>]*?cdn-telegram\.org[^\s"'<>]*?\.(?:mp4|webm|m4v)[^\s"'<>]*/gi;
    const imageRe = /https:\/\/[^\s"'<>]*?cdn-telegram\.org[^\s"'<>]*?\.(?:jpg|png|webp)[^\s"'<>]*/gi;
    const audioRe = /https:\/\/[^\s"'<>]*?cdn-telegram\.org[^\s"'<>]*?\.(?:mp3|ogg|opus|m4a|flac|wav)[^\s"'<>]*/gi;
    const docRe = /https:\/\/[^\s"'<>]*?cdn-telegram\.org[^\s"'<>]*?\.(?:pdf|zip|rar|7z|tar|gz)[^\s"'<>]*/gi;

    for (const m of html.matchAll(videoRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 22, metadata: { source: 'tg-video' } });
    for (const m of html.matchAll(imageRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 12, metadata: { source: 'tg-image' } });
    for (const m of html.matchAll(audioRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'audio', confidenceDelta: 20, metadata: { source: 'tg-audio' } });
    for (const m of html.matchAll(docRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 15, metadata: { source: 'tg-document' } });
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (hostname.endsWith('cdn-telegram.org') || hostname.endsWith('t.me')) {
          const ext = link.url.split('?')[0]?.toLowerCase();
          const type = /\.(mp4|webm)/i.test(ext ?? '') ? 'video' : /\.(mp3|ogg|opus|m4a)/i.test(ext ?? '') ? 'audio' : /\.(jpg|png|webp)/i.test(ext ?? '') ? 'image' : 'video';
          results.push({ url: link.url, type, confidenceDelta: 16, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/cdn-telegram\.org/.test(url)) {
      if (/\.(mp4|webm)/i.test(url)) return Math.max(candidate.confidence, 65);
      if (/\.(mp3|ogg|opus|m4a|flac)/i.test(url)) return Math.max(candidate.confidence, 60);
      if (/\.(jpg|png|webp)/i.test(url)) return Math.max(candidate.confidence, 40);
      return Math.max(candidate.confidence, 45);
    }
    return candidate.confidence + 5;
  }
}
