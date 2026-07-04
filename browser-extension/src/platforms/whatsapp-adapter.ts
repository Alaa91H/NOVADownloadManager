import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const HOSTS: ReadonlyArray<string> = ['web.whatsapp.com', 'wa.me', 'whatsapp.com', 'www.whatsapp.com'];
const CDN: ReadonlyArray<string> = ['*.whatsapp.net', '*.fbcdn.net'];

export class WhatsAppAdapter extends PlatformAdapter {
  readonly id = 'whatsapp';
  readonly name = 'WhatsApp';
  override readonly hosts = HOSTS;
  override readonly cdnPatterns = CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];
    this.extractFromHtml(content.html, results);
    this.extractFromLinks(content.links, results);
    return results;
  }

  private extractFromHtml(html: string, results: PlatformMediaResult[]): void {
    const mediaRe = /https:\/\/[^\s"'<>]*?(?:whatsapp|mmg-fna|fna)\.(?:whatsapp|fbcdn)\.net[^\s"'<>]*?\.(?:mp4|m4v|webm|jpg|png|webp|ogg|opus|m4a)[^\s"'<>]*/gi;
    for (const m of html.matchAll(mediaRe)) {
      const url = m[0].replace(/\\u0026/gi, '&');
      const type = /\.(mp4|webm|m4v)/i.test(url) ? 'video' : /\.(ogg|opus|m4a)/i.test(url) ? 'audio' : 'image';
      results.push({ url, type, confidenceDelta: 18, metadata: { source: 'wa-media' } });
    }
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    for (const link of links) {
      if (!link.url) continue;
      try {
        const hostname = new URL(link.url).hostname;
        if (hostname.endsWith('whatsapp.net')) {
          results.push({ url: link.url, type: /\.(mp4|webm)/i.test(link.url) ? 'video' : /\.(ogg|opus)/i.test(link.url) ? 'audio' : 'image', confidenceDelta: 16, metadata: { source: 'dom-link', tag: link.tag } });
        }
      } catch { /* ignore */ }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (/whatsapp\.net/.test(url)) {
      if (/\/video\//i.test(url) || /\.(mp4|webm)/i.test(url)) return Math.max(candidate.confidence, 60);
      if (/\/audio\//i.test(url) || /\.(ogg|opus)/i.test(url)) return Math.max(candidate.confidence, 55);
      if (/\/image\//i.test(url) || /\.(jpg|png|webp)/i.test(url)) return Math.max(candidate.confidence, 40);
      return Math.max(candidate.confidence, 45);
    }
    return candidate.confidence + 5;
  }
}
