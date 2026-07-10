import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const SOUNDCLOUD_HOSTS: ReadonlyArray<string> = ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'api.soundcloud.com'];
const SOUNDCLOUD_CDN = ['*.sndcdn.com', '*.soundcloud.com'] as const;

export class SoundCloudAdapter extends PlatformAdapter {
  readonly id = 'soundcloud';
  readonly name = 'SoundCloud';
  override readonly hosts = SOUNDCLOUD_HOSTS;
  override readonly cdnPatterns = SOUNDCLOUD_CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromHydration(content.html, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const audioRe = /https:\/\/[^\s"'<>]*?sndcdn\.com[^\s"'<>]*?\.(?:mp3|m4a|aac|flac|ogg|opus|wav)[^\s"'<>]*/gi;
    const hlsRe = /https:\/\/[^\s"'<>]*?sndcdn\.com[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    for (const m of html.matchAll(audioRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'audio', confidenceDelta: 20, metadata: { source: 'sndcdn-audio' } });
    }
    for (const m of html.matchAll(hlsRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'audio', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 18, metadata: { source: 'sndcdn-hls' } });
    }
    const imageRe = /https:\/\/[^\s"'<>]*?sndcdn\.com[^\s"'<>]*?\.(?:jpg|png|webp)[^\s"'<>]*/gi;
    for (const m of html.matchAll(imageRe)) {
      results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 5, metadata: { source: 'sndcdn-image' } });
    }
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (hostname.endsWith('sndcdn.com') && /\.(mp3|m4a|aac|flac|ogg|opus|wav|m3u8)/i.test(link.url)) {
          results.push({ url: link.url, type: 'audio', confidenceDelta: 18, metadata: { source: 'dom-link', tag: link.tag } });
        } else if (hostname === 'soundcloud.com') {
          results.push({ url: link.url, type: 'audio', confidenceDelta: 15, metadata: { source: 'sc-page-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromHydration(html: string, results: PlatformMediaResult[]): void {
    const hydrationMatch = html.match(/window\.__SC_HYDRATION\s*=\s*(\[.+?\]);/s);
    if (!hydrationMatch?.[1]) return;
    try {
      const data = JSON.parse(hydrationMatch[1]);
      for (const item of (Array.isArray(data) ? data : [])) {
        const rec = item as Record<string, unknown>;
        const hydratable = rec.hydratable as Record<string, unknown> ?? rec;
        const tracks = hydratable.tracks as Array<Record<string, unknown>> ?? [];
        for (const track of tracks) {
          const streamUrl = track.mediaUrl as string ?? (track as Record<string, unknown>).streamUrl as string;
          if (streamUrl && typeof streamUrl === 'string') {
            const title = String((track.title as string | undefined) ?? '');
            const user = track.user as Record<string, unknown> | undefined;
            const artist = String(user?.username as string | undefined ?? (track.artist as string | undefined) ?? '');
            results.push({ url: streamUrl, type: 'audio', duration: track.duration as number | undefined, confidenceDelta: 30, metadata: { source: 'sc-hydration', title, artist } });
          }
          const artwork = track.artworkUrl as string;
          if (artwork && typeof artwork === 'string') {
            results.push({ url: artwork, type: 'image', confidenceDelta: 10, metadata: { source: 'sc-hydration-artwork' } });
          }
        }
      }
    } catch { /* ignore */ }
  }

  adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/sndcdn\.com/.test(url)) {
      if (/\.(mp3|m4a|aac|flac|ogg|opus|wav)/i.test(url)) return Math.max(candidate.confidence, 65);
      if (/\.m3u8/i.test(url)) return Math.max(candidate.confidence, 55);
      return Math.max(candidate.confidence, 35);
    }
    if (/soundcloud\.com/.test(url)) return Math.max(candidate.confidence, 50);
    return candidate.confidence + 5;
  }
}
