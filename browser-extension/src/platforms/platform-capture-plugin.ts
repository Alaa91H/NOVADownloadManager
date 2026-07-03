import type { Candidate } from '../contracts/candidate.schema';
import type { CaptureContext } from '../capture/capture-context';
import type { CapturePlugin } from '../capture/capture-plugin';
import { platformRegistry } from './platform-registry';
import type { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import { CandidateSchema } from '../contracts/candidate.schema';

export class PlatformCapturePlugin implements CapturePlugin {
  readonly id = 'platform-capture';
  readonly name = 'Platform Adapters';
  readonly requiredPermissions: string[] = [];
  readonly supportedBrowsers = ['chrome', 'edge', 'firefox'] as const;

  async isEnabled(_context: CaptureContext): Promise<boolean> {
    return true;
  }

  async capture(context: CaptureContext): Promise<Candidate[]> {
    const results: Candidate[] = [];
    const pageUrl = context.pageUrl ?? context.documentUrl;

    if (pageUrl) {
      const adapter = platformRegistry.forURL(pageUrl);
      if (adapter && context.content) {
        let mediaResults = adapter.extractFromScan(context.content);
        if (adapter.canResolveManifests) {
          mediaResults = await adapter.resolveManifests(mediaResults);
        }
        for (const mr of mediaResults) {
          const baseConfidence = mr.confidenceDelta ? Math.min(100, Math.max(1, mr.confidenceDelta)) : 40;
          const candidate = this.toCandidate(mr, context, adapter, baseConfidence);
          if (candidate) results.push(candidate);
        }
      }
    }

    for (const entry of context.networkEntries ?? []) {
      const adapter = platformRegistry.forCDN(entry.url);
      if (adapter) {
        const candidates = await this.resolveAndCreateCandidates(
          [{ url: entry.url, type: 'video' }],
          context,
          adapter,
          (mr) => mr.confidenceDelta ?? (entry.headers?.contentType?.startsWith('video') ? 55 : 40),
        );
        for (const c of candidates) {
          if (!results.some((r) => r.url === c.url)) results.push(c);
        }
      }
    }

    for (const entry of context.downloadEntries ?? []) {
      const adapter = platformRegistry.forCDN(entry.url);
      if (adapter) {
        const candidates = await this.resolveAndCreateCandidates(
          [{ url: entry.url, type: entry.mime?.startsWith('video') ? 'video' : 'audio', mimeType: entry.mime }],
          context,
          adapter,
          () => 50,
        );
        for (const c of candidates) {
          if (!results.some((r) => r.url === c.url)) results.push(c);
        }
      }
    }

    return results;
  }

  private async resolveAndCreateCandidates(
    entries: PlatformMediaResult[],
    context: CaptureContext,
    adapter: PlatformAdapter,
    getConfidence: (mr: PlatformMediaResult) => number,
  ): Promise<Candidate[]> {
    let mediaResults = entries;
    if (adapter.canResolveManifests) {
      mediaResults = await adapter.resolveManifests(mediaResults);
    }
    const candidates: Candidate[] = [];
    for (const mr of mediaResults) {
      const baseConfidence = getConfidence(mr);
      const candidate = this.toCandidate(mr, context, adapter, baseConfidence);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  private toCandidate(
    mr: { url: string; type: string; mimeType?: string; quality?: string; width?: number; height?: number; duration?: number; originalUrl?: string; metadata?: Record<string, string> },
    context: CaptureContext,
    adapter: PlatformAdapter,
    baseConfidence: number,
  ): Candidate | null {
    const enriched = adapter.enrichCandidate({
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      url: mr.url,
      pageUrl: context.pageUrl ?? context.documentUrl,
      referrer: context.documentUrl,
      source: 'platform',
      mediaType: mr.type === 'audio' ? 'audio' : mr.type === 'image' ? 'image' : 'video',
      mimeType: mr.mimeType,
      width: mr.width,
      height: mr.height,
      durationSec: mr.duration,
      confidence: adapter.adjustConfidence({ ...{ url: mr.url, confidence: baseConfidence } } as Candidate),
      createdAt: context.now ?? new Date().toISOString(),
      metadata: { ...(mr.metadata ?? {}), platform: adapter.id },
    }, context.content);
    const parsed = CandidateSchema.safeParse(enriched);
    return parsed.success ? parsed.data : null;
  }
}
