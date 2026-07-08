import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const HOSTS: ReadonlyArray<string> = ['vk.com', 'www.vk.com', 'm.vk.com', 'vk.ru', 'vkontakte.ru'];
const CDN: ReadonlyArray<string> = ['*.vk.com', '*.vk.me', '*.vkvideo.ru', '*.userapi.com', '*.mycdn.me'];

export class VkAdapter extends PlatformAdapter {
  readonly id = 'vk';
  readonly name = 'VK';
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
    const mp4Re = /https:\/\/[^\s"'<>]*?(?:userapi|vk\.(?:com|me)|mycdn|vkvideo)\.(?:com|ru|me)[^\s"'<>]*?\.(?:mp4|webm)[^\s"'<>]*/gi;
    const m3u8Re = /https:\/\/[^\s"'<>]*?(?:userapi|vk\.(?:com|me)|mycdn)\.(?:com|ru|me)[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const imageRe = /https:\/\/[^\s"'<>]*?(?:userapi|vk\.(?:com|me)|mycdn)\.(?:com|ru|me)[^\s"'<>]*?\.(?:jpg|png|webp)[^\s"'<>]*/gi;
    const audioRe = /https:\/\/[^\s"'<>]*?(?:userapi|vk\.(?:com|me)|mycdn)\.(?:com|ru|me)[^\s"'<>]*?\.(?:mp3|m4a|ogg|flac|opus)[^\s"'<>]*/gi;

    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 20, metadata: { source: 'vk-video' } });
    for (const m of html.matchAll(m3u8Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 20, metadata: { source: 'vk-hls' } });
    for (const m of html.matchAll(imageRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 10, metadata: { source: 'vk-image' } });
    for (const m of html.matchAll(audioRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'audio', confidenceDelta: 18, metadata: { source: 'vk-audio' } });
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (this.cdnPatterns.some((p) => hostname.endsWith(p.slice(1)))) {
          const ext = link.url.split('?')[0]?.toLowerCase();
          const type = /\.(mp4|webm)/i.test(ext ?? '') ? 'video' : /\.(mp3|m4a|ogg|flac)/i.test(ext ?? '') ? 'audio' : 'image';
          results.push({ url: link.url, type, confidenceDelta: 15, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromOpenGraph(og: ContentScanResponse['openGraph'], results: PlatformMediaResult[]): void {
    if (!og) return;
    for (const entry of og) {
      if (entry.attr?.includes('og:video') || (entry.attr?.includes('og:image') && entry.url.includes('vk.com'))) {
        results.push({ url: entry.url, type: 'video', confidenceDelta: 18, metadata: { source: 'og', property: entry.attr } });
      }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/userapi\.com|vk\.(?:com|me)|mycdn\.me|vkvideo\.ru/.test(url)) {
      if (/\.(mp4|webm)/i.test(url)) return Math.max(candidate.confidence, 65);
      if (/\.m3u8/i.test(url)) return Math.max(candidate.confidence, 60);
      if (/\.(mp3|flac)/i.test(url)) return Math.max(candidate.confidence, 55);
      return Math.max(candidate.confidence, 35);
    }
    return candidate.confidence + 5;
  }
}
