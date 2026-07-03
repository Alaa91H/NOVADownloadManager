import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const PROTOCOL = 'https';
const TWITCH_HOSTS: ReadonlyArray<string> = ['www.twitch.tv', 'twitch.tv', 'm.twitch.tv', 'clips.twitch.tv', 'player.twitch.tv'];
const TWITCH_CDN = ['*.twitchcdn.net', '*.ttvnw.net', '*.jtvnw.net', '*.twitch.tv'] as const;

export class TwitchAdapter extends PlatformAdapter {
  readonly id = 'twitch';
  readonly name = 'Twitch';
  override readonly hosts = TWITCH_HOSTS;
  override readonly cdnPatterns = TWITCH_CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromOpenGraph(content.openGraph, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const m3u8Re = /https:\/\/[^\s"'<>]*?(?:twitchcdn|ttvnw|jtvnw)\.[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const mp4Re = /https:\/\/[^\s"'<>]*?(?:twitchcdn|ttvnw|jtvnw)\.[^\s"'<>]*?\.mp4[^\s"'<>]*/gi;
    const clipRe = /https:\/\/clips\.twitch\.tv\/(?:embed\?clip=)?([a-zA-Z0-9_-]+)/gi;
    const vodRe = /https:\/\/www\.twitch\.tv\/videos\/(\d+)/gi;

    for (const m of html.matchAll(m3u8Re)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 20, metadata: { source: 'twitch-hls' } });
    }
    for (const m of html.matchAll(mp4Re)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 18, metadata: { source: 'twitch-mp4' } });
    }
    for (const m of html.matchAll(clipRe)) {
      const clipId = m[1];
      if (clipId) results.push({ url: `${PROTOCOL}://clips.twitch.tv/${clipId}`, type: 'video', confidenceDelta: 30, metadata: { source: 'twitch-clip', clipId } });
    }
    for (const m of html.matchAll(vodRe)) {
      const vodId = m[1];
      if (vodId) results.push({ url: `${PROTOCOL}://www.twitch.tv/videos/${vodId}`, type: 'video', confidenceDelta: 25, metadata: { source: 'twitch-vod', vodId } });
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

  private extractFromOpenGraph(og: ContentScanResponse['openGraph'], results: PlatformMediaResult[]): void {
    if (!og) return;
    for (const entry of og) {
      if (entry.attr?.includes('og:video') || entry.attr?.includes('og:image') || entry.attr?.includes('twitter:player')) {
        results.push({ url: entry.url, type: 'video', confidenceDelta: 20, metadata: { source: 'og', property: entry.attr } });
      }
    }
  }

  adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/twitchcdn\.net|ttvnw\.net|jtvnw\.net/.test(url)) {
      if (/\.m3u8/i.test(url)) return Math.max(candidate.confidence, 65);
      return Math.max(candidate.confidence, 45);
    }
    if (/clips\.twitch\.tv/.test(url)) return Math.max(candidate.confidence, 70);
    if (/twitch\.tv\/videos/.test(url)) return Math.max(candidate.confidence, 60);
    return candidate.confidence + 5;
  }
}
