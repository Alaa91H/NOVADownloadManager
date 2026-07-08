import { z } from 'zod';
import { legacyPascalProductToken } from '../core/legacy-names';

export const MediaTypeFilterSchema = z.enum(['video', 'audio', 'image', 'document', 'archive', 'app', 'torrent', 'magnet', 'manifest', 'other']);

export const CaptureSettingsSchema = z.object({
  dom: z.boolean().default(true),
  network: z.boolean().default(false),
  downloads: z.boolean().default(false),
  hlsDash: z.boolean().default(true),
  mediaProbe: z.boolean().default(true),
  minFileSizeMB: z.number().nonnegative().default(1),
  showLowConfidence: z.boolean().default(false),
  preferManifestQualities: z.boolean().default(true),
  liveQualityRefresh: z.boolean().default(true),
  aggressiveMode: z.boolean().default(false),
  // Downloads takeover settings (Phase 5)
  takeoverEnabled: z.boolean().default(false),
  askBeforeTakeover: z.boolean().default(true),
  takeoverMinSizeMB: z.number().nonnegative().default(0),
  takeoverFileTypes: z.array(z.string()).default([]),
  neverTakeoverHosts: z.array(z.string()).default([]),
  alwaysTakeoverHosts: z.array(z.string()).default([]),
});


export const PopupDefaultTabSchema = z.enum(['connection', 'candidates', 'tasks', 'popup-options', 'capture-options']);
export const PopupDensitySchema = z.enum(['comfortable', 'compact', 'dense']);
export const PopupSettingsSchema = z.object({
  defaultTab: PopupDefaultTabSchema.default('connection'),
  density: PopupDensitySchema.default('comfortable'),
  showTechnicalConnectionDetails: z.boolean().default(true),
  showOutboxOnConnection: z.boolean().default(true),
  showCandidateCounts: z.boolean().default(true),
  showTaskTab: z.boolean().default(true),
  autoRefreshCandidates: z.boolean().default(true),
  candidateRefreshMs: z.number().int().min(1000).max(30000).default(2500),
  maxVisibleCandidates: z.number().int().min(20).max(500).default(150),
  confirmBeforeSendAll: z.boolean().default(false),
  showHandoffWarnings: z.boolean().default(true),
});

export const OverlayPositionSchema = z.enum(['top-right', 'top-left', 'bottom-right', 'bottom-left', 'custom']);
export const OverlayOpenDirectionSchema = z.enum(['auto', 'up', 'down', 'left', 'right']);
export const OverlayThemeSchema = z.enum(['auto', 'light', 'dark']);
export const OverlayPositionScopeSchema = z.enum(['global', 'domain', 'site']);
export const OverlayPresetSchema = z.enum(['custom', 'minimal', 'smart', 'media-focused', 'power-user', 'store-safe']);
export const OverlayPickerSelectionSchema = z.enum(['all', 'high-confidence', 'none']);

export const OverlaySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  preset: OverlayPresetSchema.default('smart'),
  showOnlyWhenCandidates: z.boolean().default(true),
  defaultPosition: OverlayPositionSchema.default('top-right'),
  openDirection: OverlayOpenDirectionSchema.default('auto'),
  rememberDraggedPosition: z.boolean().default(true),
  positionScope: OverlayPositionScopeSchema.default('global'),
  snapToEdges: z.boolean().default(false),
  compactPermanentActions: z.boolean().default(true),
  showProgramLogo: z.boolean().default(false),
  attachPickerToOverlay: z.boolean().default(true),
  opacity: z.number().min(0.2).max(1).default(0.86),
  hoverOpacity: z.number().min(0.2).max(1).default(1),
  buttonSizePx: z.number().int().min(32).max(72).default(46),
  scale: z.number().min(0.7).max(1.4).default(1),
  menuAnimationMs: z.number().int().min(0).max(400).default(100),
  zIndex: z.number().int().min(1000).max(2147483647).default(2147483647),
  keyboardNudgePx: z.number().int().min(1).max(50).default(8),
  autoHideWhenIdle: z.boolean().default(false),
  idleAfterMs: z.number().int().min(1000).max(60000).default(8000),
  minConfidence: z.number().min(0).max(100).default(20),
  smartVideoOnlyOnVideoPages: z.boolean().default(true),
  smartVideoMaxItems: z.number().int().min(1).max(200).default(60),
  smartVideoContinuousRefresh: z.boolean().default(true),
  smartVideoRefreshMs: z.number().int().min(250).max(15000).default(1000),
  maxPickerItems: z.number().int().min(10).max(500).default(100),
  defaultPickerSelection: OverlayPickerSelectionSchema.default('high-confidence'),
  minFileSizeMB: z.number().nonnegative().default(1),
  maxFileSizeMB: z.number().nonnegative().default(0),
  hideWhenFiltersRejectAll: z.boolean().default(true),
  mediaTypes: z.array(MediaTypeFilterSchema).default(['video', 'audio', 'image', 'document', 'archive', 'app', 'torrent', 'magnet', 'manifest', 'other']),
  extensionsAllowlist: z.array(z.string().trim().min(1).max(16)).default([]),
  extensionsBlocklist: z.array(z.string().trim().min(1).max(16)).default(['css', 'js', 'woff', 'woff2', 'ttf', 'ico']),
});

// Capture profile (Phase 9)
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
  overlay: OverlaySettingsSchema.default(() => OverlaySettingsSchema.parse({})),
  popup: PopupSettingsSchema.default(() => PopupSettingsSchema.parse({})),
});
export type Settings = z.infer<typeof SettingsSchema>;
export type OverlaySettings = Settings['overlay'];
export type PopupSettings = Settings['popup'];
export const defaultSettings: Settings = SettingsSchema.parse({});
