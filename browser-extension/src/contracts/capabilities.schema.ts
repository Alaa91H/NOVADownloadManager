import { z } from 'zod';
import { AdmExtensionError } from '../core/error-classification';

// Full set of capabilities the ADM desktop may advertise. The extension only
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
export const CapabilitiesSchema = z.object({ items: z.array(CapabilitySchema).default([]) });
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
      throw new AdmExtensionError({ code: 'CAPABILITY_UNSUPPORTED', message: `ADM capability unsupported: ${c}`, retryable: false, details: { capability: c } });
    }
  }

  list(): Capability[] {
    return [...this.caps];
  }
}
