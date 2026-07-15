import { z } from 'zod';
import { legacyPascalProductToken } from '../core/legacy-names';

export const MediaTypeFilterSchema = z.enum(['video', 'audio', 'image', 'document', 'archive', 'app', 'torrent', 'magnet', 'manifest', 'other']);

export const CaptureSettingsSchema = z.object({
  dom: z.boolean().default(true),
  network: z.boolean().default(true),
  downloads: z.boolean().default(true),
  hlsDash: z.boolean().default(true),
  mediaProbe: z.boolean().default(true),
  minFileSizeMB: z.number().nonnegative().default(0.1),
  showLowConfidence: z.boolean().default(false),
  preferManifestQualities: z.boolean().default(true),
  liveQualityRefresh: z.boolean().default(true),
  aggressiveMode: z.boolean().default(false),
  takeoverEnabled: z.boolean().default(false),
  askBeforeTakeover: z.boolean().default(true),
  takeoverMinSizeMB: z.number().nonnegative().default(1),
  takeoverFileTypes: z.array(z.string()).default([]),
  neverTakeoverHosts: z.array(z.string()).default([]),
  alwaysTakeoverHosts: z.array(z.string()).default([]),
});

export const CaptureProfileSchema = z.enum(['store-safe', 'smart', 'aggressive', 'power-user', 'enterprise']);
export type CaptureProfile = z.infer<typeof CaptureProfileSchema>;

function legacyOpenAfterSendKey(): string {
  return `open${legacyPascalProductToken()}AfterSend`;
}

export function migrateSettingsInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const openAfterSendKey = legacyOpenAfterSendKey();
  if (next.openNovaAfterSend === undefined && next[openAfterSendKey] !== undefined) {
    next.openNovaAfterSend = next[openAfterSendKey];
  }
  delete next[openAfterSendKey];
  return next;
}

export const SettingsSchema = z.object({
  enabled: z.boolean().default(true),
  autoConnect: z.boolean().default(true),
  notifications: z.boolean().default(true),
  showBadge: z.boolean().default(true),
  openNovaAfterSend: z.boolean().default(false),
  captureProfile: CaptureProfileSchema.default('smart'),
  capture: CaptureSettingsSchema.default(() => CaptureSettingsSchema.parse({})),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const defaultSettings: Settings = SettingsSchema.parse({});
