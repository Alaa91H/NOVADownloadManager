import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const PROTOCOL = 'https';
const REDDIT_HOSTS: ReadonlyArray<string> = ['www.reddit.com', 'reddit.com', 'old.reddit.com', 'm.reddit.com', 'new.reddit.com'];
const REDDIT_CDN = ['*.redd.it', '*.redditmedia.com', '*.redditstatic.com', '*.thumbs.redditmedia.com'] as const;

export class RedditAdapter extends PlatformAdapter {
  readonly id = 'reddit';
  readonly name = 'Reddit';
  override readonly hosts = REDDIT_HOSTS;
  override readonly cdnPatterns = REDDIT_CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromJsonLd(content.jsonLd, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const vRedditRe = /https:\/\/v\.redd\.it\/([^\s"'<>]+)/gi;
    const iRedditRe = /https:\/\/i\.redd\.it\/([^\s"'<>]+)/gi;
    const previewRe = /https:\/\/preview\.redd\.it\/([^\s"'<>]+)/gi;
    const dashRe = /https:\/\/v\.redd\.it\/[^\s"'<>]*?\.mpd[^\s"'<>]*/gi;
    const hlsRe = /https:\/\/v\.redd\.it\/[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;

    for (const m of html.matchAll(hlsRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 25, metadata: { source: 'v.redd.it-hls' } });
    }
    for (const m of html.matchAll(dashRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/dash+xml', confidenceDelta: 25, metadata: { source: 'v.redd.it-dash' } });
    }
    for (const m of html.matchAll(vRedditRe)) {
      const vid = m[1]!;
      const baseUrl = `${PROTOCOL}://v.redd.it/${vid}`;
      results.push({ url: baseUrl, type: 'video', confidenceDelta: 20, metadata: { source: 'v.redd.it', videoId: vid } });
      results.push({ url: `${baseUrl}/DASH_720.mp4`, type: 'video', confidenceDelta: 22, metadata: { source: 'v.redd.it-720', videoId: vid } });
      results.push({ url: `${baseUrl}/DASH_480.mp4`, type: 'video', confidenceDelta: 22, metadata: { source: 'v.redd.it-480', videoId: vid } });
      results.push({ url: `${baseUrl}/DASH_360.mp4`, type: 'video', confidenceDelta: 22, metadata: { source: 'v.redd.it-360', videoId: vid } });
      results.push({ url: `${baseUrl}/DASHPlaylist.mpd`, type: 'video', mimeType: 'application/dash+xml', confidenceDelta: 22, metadata: { source: 'v.redd.it-mpd', videoId: vid } });
      results.push({ url: `${baseUrl}/HLSPlaylist.m3u8`, type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 22, metadata: { source: 'v.redd.it-hls', videoId: vid } });
    }
    for (const m of html.matchAll(iRedditRe)) {
      results.push({ url: `${PROTOCOL}://i.redd.it/${m[1]}`, type: 'image', confidenceDelta: 15, metadata: { source: 'i.redd.it' } });
    }
    for (const m of html.matchAll(previewRe)) {
      results.push({ url: `${PROTOCOL}://preview.redd.it/${m[1]}`, type: 'image', confidenceDelta: 5, metadata: { source: 'preview.redd.it' } });
    }
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (hostname === 'v.redd.it') {
          results.push({ url: link.url, type: 'video', confidenceDelta: 20, metadata: { source: 'dom-link-reddit-video', tag: link.tag } });
        } else if (hostname === 'i.redd.it') {
          results.push({ url: link.url, type: 'image', confidenceDelta: 15, metadata: { source: 'dom-link-reddit-image', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromJsonLd(jsonLd: ContentScanResponse['jsonLd'], results: PlatformMediaResult[]): void {
    if (!jsonLd) return;
    for (const entry of jsonLd) {
      if (typeof entry !== 'object' || !entry) continue;
      const obj = entry as Record<string, unknown>;
      if (typeof obj.contentUrl === 'string' && (obj.contentUrl as string).includes('redd.it')) {
        results.push({ url: obj.contentUrl as string, type: 'video', confidenceDelta: 20, metadata: { source: 'jsonld' } });
      }
    }
  }

  adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/v\.redd\.it/.test(url)) {
      if (/DASH_\d+\.mp4|\.m3u8|\.mpd/i.test(url)) return Math.max(candidate.confidence, 70);
      return Math.max(candidate.confidence, 55);
    }
    if (/i\.redd\.it/.test(url)) return Math.max(candidate.confidence, 55);
    if (/preview\.redd\.it/.test(url)) return Math.max(candidate.confidence, 30);
    return candidate.confidence + 5;
  }
}
