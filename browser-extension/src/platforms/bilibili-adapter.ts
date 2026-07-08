import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const HOSTS: ReadonlyArray<string> = ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'www.bilibili.tv', 'bilibili.tv'];
const CDN: ReadonlyArray<string> = ['*.bilibili.com', '*.hdslb.com', '*.bilivideo.com', '*.bilivideo.cn', '*.b23.tv', '*.acgvideo.com'];

export class BilibiliAdapter extends PlatformAdapter {
  readonly id = 'bilibili';
  readonly name = 'Bilibili';
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
    const mp4Re = /https:\/\/[^\s"'<>]*?(?:hdslb|bilivideo|acgvideo)\.(?:com|cn)[^\s"'<>]*?\.(?:mp4|m4v|flv)[^\s"'<>]*/gi;
    const m3u8Re = /https:\/\/[^\s"'<>]*?(?:hdslb|bilivideo|acgvideo)\.(?:com|cn)[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const imageRe = /https:\/\/[^\s"'<>]*?(?:hdslb|bilivideo)\.(?:com|cn)[^\s"'<>]*?\.(?:jpg|png|webp)[^\s"'<>]*/gi;
    const dashRe = /https:\/\/[^\s"'<>]*?(?:hdslb|bilivideo)\.(?:com|cn)[^\s"'<>]*?\.mpd[^\s"'<>]*/gi;

    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 20, metadata: { source: 'bili-video' } });
    for (const m of html.matchAll(m3u8Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 18, metadata: { source: 'bili-hls' } });
    for (const m of html.matchAll(imageRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 10, metadata: { source: 'bili-image' } });
    for (const m of html.matchAll(dashRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/dash+xml', confidenceDelta: 20, metadata: { source: 'bili-dash' } });
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (this.cdnPatterns.some((p) => hostname.endsWith(p.slice(1)))) {
          results.push({ url: link.url, type: /\.(mp4|m3u8|mpd|flv)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 15, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromInitialState(html: string, results: PlatformMediaResult[]): void {
    const re = /window\.__INITIAL_STATE__\s*=\s*({.+?});\s*</s;
    const m = html.match(re);
    if (!m?.[1]) return;
    try {
      const data = JSON.parse(m[1]);
      const videoData = data.videoData ?? data.initState?.videoData ?? data;
      const pages = (videoData.pages as Array<Record<string, unknown>>) ?? [];
      for (const page of pages) {
        const part = page.part as Record<string, unknown> | undefined;
        if (part?.video) {
          const vid = part.video as Record<string, unknown>;
          for (const [quality, url] of Object.entries(vid)) {
            if (typeof url === 'string' && /https?:\/\//.test(url)) {
              results.push({ url, type: 'video', quality, confidenceDelta: 28, metadata: { source: 'bili-initial-state', quality } });
            }
          }
        }
      }
      const dashUrl = videoData.dash?.video as string | undefined;
      if (dashUrl) {
        results.push({ url: dashUrl, type: 'video', mimeType: 'application/dash+xml', confidenceDelta: 25, metadata: { source: 'bili-dash-url' } });
      }
    } catch { /* ignore */ }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/hdslb\.com|bilivideo\.(?:com|cn)|acgvideo\.com/.test(url)) {
      if (/\.(mp4|flv)/i.test(url)) return Math.max(candidate.confidence, 65);
      if (/\.(m3u8|mpd)/i.test(url)) return Math.max(candidate.confidence, 60);
      return Math.max(candidate.confidence, 40);
    }
    return candidate.confidence + 5;
  }
}
