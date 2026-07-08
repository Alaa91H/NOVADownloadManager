import { z } from 'zod';
import { NovaExtensionError } from '../core/error-classification';

// Full set of capabilities the NOVA desktop may advertise. The extension only
// invokes a capability when it both (a) appears here and (b) has a calling site.
// Phase 6 additions: stream.* capabilities for HLS/DASH manifest handling.
export const CapabilitySchema = z.enum([
  'candidate.directUrl','candidate.torrent','candidate.magnet','candidate.hls','candidate.dash',
  'task.add','task.addBatch','task.pause','task.resume','task.cancel',
  'events.sse','events.websocket','settings.snapshot','page.extract',
  'refreshAddress.candidate','refreshAddress.apply',
  // Stream manifest capabilities (Phase 6)
  'stream.hls.detect','stream.hls.resolve','stream.hls.download',
  'stream.dash.detect','stream.dash.resolve','stream.dash.download',
  'stream.quality.select','stream.subtitles','stream.audioTracks','stream.refreshUrl',
]);
export type Capability = z.infer<typeof CapabilitySchema>;
export const RuntimeEngineCapabilitiesSchema = z.record(z.string(), z.unknown()).optional();
export const CapabilitiesSchema = z.object({
  items: z.array(CapabilitySchema).default([]),
  engineCapabilities: RuntimeEngineCapabilitiesSchema,
  directOptionKeys: z.array(z.string()).default([]).optional(),
  mediaOptionKeys: z.array(z.string()).default([]).optional(),
  directProtocols: z.array(z.string()).default([]).optional(),
  streamResolverReady: z.boolean().default(false).optional(),
  unsupportedCandidateMediaTypes: z.array(z.string()).default([]).optional(),
  sourceOfTruth: z.string().optional(),
}).passthrough();
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export class CapabilityRegistry {
  constructor(private caps: ReadonlySet<Capability> = new Set()) {}

  update(c: Capabilities): void {
    this.caps = new Set(c.items);
  }

  has(c: Capability): boolean {
    return this.caps.has(c);
  }

  require(c: Capability): void {
    if (!this.has(c)) {
      throw new NovaExtensionError({ code: 'CAPABILITY_UNSUPPORTED', message: `NOVA capability unsupported: ${c}`, retryable: false, details: { capability: c } });
    }
  }

  list(): Capability[] {
    return [...this.caps];
  }
}


function protocolFromCandidate(candidate: { url?: string; finalUrl?: string }): string | undefined {
  const raw = candidate.finalUrl ?? candidate.url;
  if (!raw) return undefined;
  try {
    return new URL(raw).protocol.replace(/:$/, '').toLowerCase();
  } catch {
    return undefined;
  }
}

export function capabilitiesForCandidate(candidate: { mediaType?: string; source?: string; url?: string; finalUrl?: string }, capabilities?: Capabilities): { supported: boolean; missing?: Capability | 'direct.protocol' } {
  const registry = new CapabilityRegistry(new Set(capabilities?.items ?? []));
  if (candidate.mediaType === 'torrent') return { supported: registry.has('candidate.torrent'), missing: 'candidate.torrent' };
  if (candidate.mediaType === 'magnet') return { supported: registry.has('candidate.magnet'), missing: 'candidate.magnet' };
  if (candidate.source === 'hls-manifest') return { supported: registry.has('candidate.hls'), missing: 'candidate.hls' };
  if (candidate.source === 'dash-manifest') return { supported: registry.has('candidate.dash'), missing: 'candidate.dash' };
  if (candidate.mediaType === 'manifest') return { supported: registry.has('candidate.hls') || registry.has('candidate.dash'), missing: 'candidate.hls' };
  if (!registry.has('candidate.directUrl')) return { supported: false, missing: 'candidate.directUrl' };
  const protocol = protocolFromCandidate(candidate);
  const advertised = new Set((capabilities?.directProtocols ?? []).map((item) => item.toLowerCase()));
  if (protocol && advertised.size > 0 && !advertised.has(protocol)) return { supported: false, missing: 'direct.protocol' };
  return { supported: true };
}
