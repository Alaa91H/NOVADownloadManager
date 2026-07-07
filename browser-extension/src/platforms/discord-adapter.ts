import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const HOSTS: ReadonlyArray<string> = ['discord.com', 'www.discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com', 'www.discordapp.com'];
const CDN: ReadonlyArray<string> = ['*.discordapp.com', '*.discord.com', '*.discord.media', '*.discordapp.net'];

export class DiscordAdapter extends PlatformAdapter {
  readonly id = 'discord';
  readonly name = 'Discord';
  override readonly hosts = HOSTS;
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const cdnRe = /https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/attachments\/[^\s"'<>]+/gi;
    const mp4Re = /https:\/\/[^\s"'<>]*?discord(?:app)?\.(?:com|net|media)[^\s"'<>]*?\.(?:mp4|webm|mov|m4v)[^\s"'<>]*/gi;
    const imageRe = /https:\/\/[^\s"'<>]*?discord(?:app)?\.(?:com|net|media)[^\s"'<>]*?\.(?:jpg|png|gif|webp)[^\s"'<>]*/gi;
    const audioRe = /https:\/\/[^\s"'<>]*?discord(?:app)?\.(?:com|net|media)[^\s"'<>]*?\.(?:mp3|m4a|ogg|flac|wav|opus)[^\s"'<>]*/gi;

    for (const m of html.matchAll(cdnRe)) results.push({ url: m[0], type: 'video', confidenceDelta: 18, metadata: { source: 'discord-cdn' } });
    for (const m of html.matchAll(mp4Re)) results.push({ url: m[0], type: 'video', confidenceDelta: 20, metadata: { source: 'discord-video' } });
    for (const m of html.matchAll(imageRe)) results.push({ url: m[0], type: 'image', confidenceDelta: 12, metadata: { source: 'discord-image' } });
    for (const m of html.matchAll(audioRe)) results.push({ url: m[0], type: 'audio', confidenceDelta: 18, metadata: { source: 'discord-audio' } });
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (this.cdnPatterns.some((p) => hostname.endsWith(p.slice(1)))) {
          const ext = link.url.split('?')[0]?.toLowerCase();
          const type = /\.(mp4|webm|mov|m4v)/i.test(ext ?? '') ? 'video' : /\.(mp3|m4a|ogg|flac|wav)/i.test(ext ?? '') ? 'audio' : 'image';
          results.push({ url: link.url, type, confidenceDelta: 16, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/discordapp\.(com|net)|discord\.(com|media)/.test(url)) {
      if (/(?:attachments|ephemeral-attachments)/.test(url)) return Math.max(candidate.confidence, 65);
      if (/\.(mp4|webm)/i.test(url)) return Math.max(candidate.confidence, 60);
      if (/\.(mp3|flac|wav)/i.test(url)) return Math.max(candidate.confidence, 55);
      return Math.max(candidate.confidence, 40);
    }
    return candidate.confidence + 5;
  }
}
