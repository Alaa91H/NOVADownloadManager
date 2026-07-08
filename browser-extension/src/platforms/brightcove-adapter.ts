import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const PROTOCOL = 'https';
/** Brightcove is used by major news orgs (e.g. NYT, WSJ, Bloomberg, MLB) */
const CDN: ReadonlyArray<string> = ['*.brightcove.com', '*.brightcove.net', '*.bcovcdn.com', '*.bcove.video', '*.players.brightcove.net', '*.live.brightcove.com'];

export class BrightcoveAdapter extends PlatformAdapter {
  readonly id = 'brightcove';
  readonly name = 'Brightcove';
  readonly hosts: ReadonlyArray<string> = [];
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    this.extractFromPlayers(content.html, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const mp4Re = /https:\/\/[^\s"'<>]*?bcovcdn\.com[^\s"'<>]*?\.mp4[^\s"'<>]*/gi;
    const hlsRe = /https:\/\/[^\s"'<>]*?bcovcdn\.com[^\s"'<>]*?\.m3u8[^\s"'<>]*/gi;
    const dashRe = /https:\/\/[^\s"'<>]*?bcovcdn\.com[^\s"'<>]*?\.mpd[^\s"'<>]*/gi;
    const imageRe = /https:\/\/[^\s"'<>]*?brightcove\.net[^\s"'<>]*?\.(?:jpg|png|webp)[^\s"'<>]*/gi;

    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', confidenceDelta: 22, metadata: { source: 'bc-mp4' } });
    for (const m of html.matchAll(hlsRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/vnd.apple.mpegurl', confidenceDelta: 20, metadata: { source: 'bc-hls' } });
    for (const m of html.matchAll(dashRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'video', mimeType: 'application/dash+xml', confidenceDelta: 22, metadata: { source: 'bc-dash' } });
    for (const m of html.matchAll(imageRe)) results.push({ url: m[0].replace(/\\u0026/gi, '&'), type: 'image', confidenceDelta: 8, metadata: { source: 'bc-image' } });
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (this.cdnPatterns.some((p) => hostname.endsWith(p.slice(1)))) {
          results.push({ url: link.url, type: /\.(mp4|m3u8|mpd)/i.test(link.url) ? 'video' : 'image', confidenceDelta: 18, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  private extractFromPlayers(html: string, results: PlatformMediaResult[]): void {
    const playerRe = /players\.brightcove\.net\/(\d+)\/([a-zA-Z0-9_]+)_(?:default|embed)\/index\.html\?videoId=(\d+)/gi;
    for (const m of html.matchAll(playerRe)) {
      const accountId = m[1];
      const playerId = m[2];
      const videoId = m[3];
      if (accountId && playerId && videoId) {
        results.push({
          url: `${PROTOCOL}://players.brightcove.net/${accountId}/${playerId}_default/index.html?videoId=${videoId}`,
          type: 'video', confidenceDelta: 20, metadata: { source: 'bc-player-embed', accountId: accountId!, playerId: playerId!, videoId: videoId! },
        });
      }
    }

    const policyKeyRe = /"policyKey"\s*:\s*"([^"]+?)"/gi;
    const accountRe = /"accountId"\s*:\s*"(\d+?)"/gi;
    const videoIdRe = /"videoId"\s*:\s*"(\d+?)"/gi;
    const policyMatches = [...html.matchAll(policyKeyRe)];
    const accountMatches = [...html.matchAll(accountRe)];
    const videoIdMatches = [...html.matchAll(videoIdRe)];
    if (policyMatches.length > 0 && accountMatches.length > 0 && videoIdMatches.length > 0) {
      for (let i = 0; i < Math.min(policyMatches.length, accountMatches.length, videoIdMatches.length); i++) {
        const apiUrl = `${PROTOCOL}://edge.api.brightcove.com/playback/v1/accounts/${accountMatches[i]![1]}/videos/${videoIdMatches[i]![1]}`;
        if (!results.some((r) => r.url === apiUrl)) {
          results.push({ url: apiUrl, type: 'video', confidenceDelta: 25, metadata: { source: 'bc-playback-api' } });
        }
      }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/bcovcdn\.com/.test(url)) return Math.max(candidate.confidence, 65);
    if (/(?:edge\.api|players)\.brightcove\.(?:com|net)/.test(url)) return Math.max(candidate.confidence, 55);
    if (/brightcove\.net/.test(url) && /\.(mp4|m3u8|mpd)/i.test(url)) return Math.max(candidate.confidence, 60);
    return candidate.confidence + 10;
  }
}
