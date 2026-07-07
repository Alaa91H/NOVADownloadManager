import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';
import { resolveHlsManifest, resolveDashManifest, isHlsUrl, isDashUrl } from './manifest-resolver';

export type PlatformMediaResult = {
  url: string;
  type: 'video' | 'audio' | 'image';
  quality?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number;
  originalUrl?: string;
  confidenceDelta?: number;
  metadata?: Record<string, string>;
};

export abstract class PlatformAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly hosts: ReadonlyArray<string>;
  readonly cdnPatterns: ReadonlyArray<string> = [];
  canResolveManifests = true;

  /** Extract platform-specific media from a content scan response */
  abstract extractFromScan(content: ContentScanResponse): PlatformMediaResult[];

  /** Check if a URL belongs to this platform's CDN */
  matchesCDN(url: string): boolean {
    if (this.cdnPatterns.length === 0) return false;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return this.cdnPatterns.some((pattern) => {
        if (pattern.startsWith('*.')) return hostname.endsWith(pattern.slice(1));
        return hostname === pattern;
      });
    } catch { return false; }
  }

  /** Enrich candidate with platform-specific metadata */
  enrichCandidate(candidate: Candidate, _scan?: ContentScanResponse): Candidate {
    return { ...candidate, source: 'platform' as Candidate['source'], metadata: { ...candidate.metadata, platform: this.id } };
  }

  /** Score/penalize confidence for platform-specific candidates */
  abstract adjustConfidence(candidate: Candidate): number;

  /**
   * Resolve HLS/DASH manifest URLs into individual quality variant URLs.
   * Override to implement platform-specific manifest fetching (e.g. with auth headers).
   */
  async resolveManifests(results: PlatformMediaResult[]): Promise<PlatformMediaResult[]> {
    if (!this.canResolveManifests) return results;
    const expanded: PlatformMediaResult[] = [];
    for (const r of results) {
      expanded.push(r);
      try {
        if (isHlsUrl(r.url)) {
          const manifest = await resolveHlsManifest(r.url);
          for (const v of manifest.variants) {
            if (v.url !== r.url && !expanded.some((e) => e.url === v.url)) {
              expanded.push({
                url: v.url,
                type: r.type,
                quality: v.label ?? (v.height ? `${v.height}p` : undefined),
                mimeType: v.mimeType ?? 'application/vnd.apple.mpegurl',
                width: v.width,
                height: v.height,
                originalUrl: r.url,
                confidenceDelta: r.confidenceDelta,
                metadata: { ...r.metadata, variant: 'hls', ...(v.bandwidth != null ? { bandwidth: v.bandwidth.toString() } : {}) },
              });
            }
          }
        } else if (isDashUrl(r.url)) {
          const manifest = await resolveDashManifest(r.url);
          for (const v of manifest.variants) {
            if (v.url !== r.url && !expanded.some((e) => e.url === v.url)) {
              expanded.push({
                url: v.url,
                type: r.type,
                quality: v.label,
                mimeType: v.mimeType ?? 'application/dash+xml',
                width: v.width,
                height: v.height,
                originalUrl: r.url,
                confidenceDelta: r.confidenceDelta,
                metadata: { ...r.metadata, variant: 'dash', ...(v.bandwidth != null ? { bandwidth: v.bandwidth.toString() } : {}) },
              });
            }
          }
        }
      } catch {
        /* manifest resolution failed, keep original */
      }
    }
    return expanded;
  }
}
