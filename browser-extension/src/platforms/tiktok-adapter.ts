import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const TIKTOK_HOSTS: ReadonlyArray<string> = ['www.tiktok.com', 'tiktok.com', 'm.tiktok.com'];
const TIKTOK_CDN = ['*.tiktokcdn.com', '*.tikcdn.net', '*.tiktokcdn-us.com', '*.tiktokv.com'] as const;

export class TikTokAdapter extends PlatformAdapter {
  readonly id = 'tiktok';
  readonly name = 'TikTok';
  readonly hosts = TIKTOK_HOSTS;
  override readonly cdnPatterns = TIKTOK_CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromSigiState(content.html, results);
    this.extractFromLinks(content.links, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const videoRe = /https:\/\/(?:[a-z0-9-]+\.)?(?:tiktokcdn|tikcdn|tiktokcdn-us|tiktokv)\.[^\s"'<>]+?\.(?:mp4|m3u8)[^\s"'<>]*/gi;
    const imageRe = /https:\/\/(?:[a-z0-9-]+\.)?(?:tiktokcdn|tikcdn|tiktokcdn-us|tiktokv)\.[^\s"'<>]+?\.(?:jpg|png|webp)[^\s"'<>]*/gi;
    for (const m of html.matchAll(videoRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 15, metadata: { source: 'html-video' } });
    }
    for (const m of html.matchAll(imageRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 10, metadata: { source: 'html-image' } });
    }
  }

  private extractFromSigiState(html: string, results: PlatformMediaResult[]): void {
    const sigiMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.+?)<\/script>/s);
    if (!sigiMatch?.[1]) return;
    try {
      const data = JSON.parse(sigiMatch[1]);
      if (data.props?.pageProps?.videoData) {
        const vd = data.props.pageProps.videoData as Record<string, unknown>;
        const vurl = (vd.downloadUrls as Record<string, string>)?.downloadAddr ?? (vd.playAddr as string) ?? (vd.downloadAddr as string);
        if (vurl && typeof vurl === 'string') {
          results.push({ url: vurl, type: 'video', width: vd.width as number | undefined, height: vd.height as number | undefined, duration: vd.duration as number | undefined, confidenceDelta: 30, metadata: { source: 'sigi-state' } });
        }
        if (typeof vd.cover === 'string') {
          results.push({ url: vd.cover, type: 'image', confidenceDelta: 15, metadata: { source: 'sigi-state-cover' } });
        }
      }
      this.traverseForTikTokUrls(data, results, new Set());
    } catch { /* ignore */ }
  }

  private traverseForTikTokUrls(obj: unknown, results: PlatformMediaResult[], visited: Set<unknown>): void {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
    visited.add(obj);
    if (Array.isArray(obj)) { for (const item of obj) this.traverseForTikTokUrls(item, results, visited); return; }
    const record = obj as Record<string, unknown>;
    for (const [key, val] of Object.entries(record)) {
      if (typeof val === 'string' && /tiktokcdn|tiktokv/.test(val) && /\.(mp4|m3u8)/i.test(val)) {
        results.push({ url: val, type: 'video', confidenceDelta: 25, metadata: { source: 'sigi-traverse', key } });
      } else if (typeof val === 'string' && /tiktokcdn|tiktokv/.test(val) && /\.(jpg|png|webp)/i.test(val)) {
        results.push({ url: val, type: 'image', confidenceDelta: 15, metadata: { source: 'sigi-traverse', key } });
      }
      this.traverseForTikTokUrls(val, results, visited);
    }
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (this.cdnPatterns.some((p) => hostname.endsWith(p.slice(1)))) {
          results.push({ url: link.url, type: /\.(mp4|m3u8)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 15, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/tiktokcdn|tikcdn|tiktokv\.com/.test(url)) {
      if (/\.mp4/i.test(url)) return Math.max(candidate.confidence, 60);
      return Math.max(candidate.confidence, 40);
    }
    return candidate.confidence + 5;
  }
}
