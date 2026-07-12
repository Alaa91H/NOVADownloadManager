import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const INSTAGRAM_HOSTS: ReadonlyArray<string> = ['www.instagram.com', 'instagram.com', 'm.instagram.com'];

export class InstagramAdapter extends PlatformAdapter {
  readonly id = 'instagram';
  readonly name = 'Instagram';
  override readonly hosts = INSTAGRAM_HOSTS;
  override readonly cdnPatterns = ['*.cdninstagram.com', '*.fbcdn.net'];

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromSharedData(content.html, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const videoRe = /https:\/\/(?:[a-z]+-)?(?:scontent\.cdninstagram\.com|video\.cdninstagram\.com|scontent\.xx\.fbcdn\.net)[^\s"'<>]+?\.mp4[^\s"'<>]*/gi;
    const imageRe = /https:\/\/(?:[a-z]+-)?(?:scontent\.cdninstagram\.com|scontent\.xx\.fbcdn\.net)[^\s"'<>]+\.(?:jpg|png|webp)[^\s"'<>]*/gi;
    for (const m of html.matchAll(videoRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 15, metadata: { source: 'html-video' } });
    }
    for (const m of html.matchAll(imageRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 10, metadata: { source: 'html-image' } });
    }
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      const hostname = this.tryHostname(link.url);
      if (!hostname) continue;
      if (/\.(?:mp4|m4v|webm)$/i.test(link.url)) {
        results.push({ url: link.url, type: 'video', confidenceDelta: 15, metadata: { source: 'dom-link', tag: link.tag } });
      } else if (/\.(?:jpg|jpeg|png|webp)$/i.test(link.url)) {
        results.push({ url: link.url, type: 'image', confidenceDelta: 10, metadata: { source: 'dom-link', tag: link.tag } });
      }
    }
  }

  private extractFromSharedData(html: string, results: PlatformMediaResult[]): void {
    const sharedData = this.extractJsonFromScript(html, /window\.__INITIAL_STATE__\s*=\s*JSON\.parse\('(.+?)'\)\s*;/s)
      ?? this.extractJsonFromScript(html, /window\.__INITIAL_STATE__\s*=\s*({.+?});\s*</s)
      ?? this.extractJsonFromScript(html, /<script[^>]*id="__NEXT_DATA__"[^>]*type="application\/json">(.+?)<\/script>/s);
    if (!sharedData) return;
    try {
      const obj = typeof sharedData === 'string' ? JSON.parse(sharedData) : sharedData;
      this.traverseSharedData(obj, results, new Set());
    } catch { /* ignore */ }
  }

  private traverseSharedData(obj: unknown, results: PlatformMediaResult[], visited: Set<unknown>): void {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
    visited.add(obj);
    if (Array.isArray(obj)) { for (const item of obj) this.traverseSharedData(item, results, visited); return; }
    const record = obj as Record<string, unknown>;
    if (record.video_url && typeof record.video_url === 'string' && /\.mp4/i.test(record.video_url)) {
      if (record.video_duration) {
        results.push({
          url: record.video_url, type: 'video', width: record.video_width as number | undefined,
          height: record.video_height as number | undefined, duration: Number(record.video_duration),
          confidenceDelta: 25, metadata: { source: 'shared-data', videoId: String(record.id ?? '') },
        });
      } else {
        results.push({
          url: record.video_url, type: 'video', confidenceDelta: 20,
          metadata: { source: 'shared-data', videoId: String(record.id ?? '') },
        });
      }
    }
    if (record.display_url && typeof record.display_url === 'string' && /\.(jpg|png|webp)/i.test(record.display_url)) {
      results.push({
        url: record.display_url, type: 'image', width: record.width as number | undefined,
        height: record.height as number | undefined, confidenceDelta: 15,
        metadata: { source: 'shared-data' },
      });
    }
    for (const val of Object.values(record)) this.traverseSharedData(val, results, visited);
  }

  private extractJsonFromScript(html: string, re: RegExp): unknown | undefined {
    const m = html.match(re);
    if (!m?.[1]) return undefined;
    try { return JSON.parse(m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\")); } catch { return undefined; }
  }

  private tryHostname(url: string): string | undefined {
    try { return new URL(url).hostname; } catch { return undefined; }
  }

  adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/cdninstagram\.com/.test(url) || /fbcdn\.net/.test(url)) {
      if (/\.mp4/i.test(url)) return Math.max(candidate.confidence, 60);
      return Math.max(candidate.confidence, 40);
    }
    return candidate.confidence + 5;
  }
}
