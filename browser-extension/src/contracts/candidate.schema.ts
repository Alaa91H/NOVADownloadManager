import { z } from 'zod';
import { DrmInfoSchema } from './drm.schema';

// Evidence sources: every layer that can observe a candidate contributes evidence.
// 'page-tap' / 'fetch' / 'xhr' are reserved for Phase 3 (page-world tap).
export const EvidenceSourceSchema = z.enum([
  'dom',
  'network',
  'downloads-api',
  'context-menu',
  'hls-manifest',
  'dash-manifest',
  'media-element',
  'opengraph',
  'jsonld',
  'page-tap',
  'fetch',
  'xhr',
  'media-source',
  'player-config',
  'redirect',
  'headers',
  'drm-detection',
  'websocket-webrtc',
  'eme',
  'encrypted-media',
  'manifest-protection',
  'platform',
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceItemSchema = z.object({
  source: EvidenceSourceSchema,
  reason: z.string().min(1).max(200),
  // Positive weight = supporting evidence; negative = penalty.
  weight: z.number().min(-100).max(100),
  observedAt: z.number().int().nonnegative(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

// Human-readable confidence level derived from final score.
export const ConfidenceLevelSchema = z.enum(['high', 'medium', 'low', 'hidden']);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const CandidateSourceSchema = z.enum(['dom','network','downloads-api','context-menu','hls-manifest','dash-manifest','media-element','opengraph','jsonld','drm-detection','websocket-webrtc','platform']);
export const MediaTypeSchema = z.enum(['video','audio','image','document','archive','app','torrent','magnet','manifest','other']);
export const VariantSchema = z.object({ url: z.string().url(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), bandwidth: z.number().int().positive().optional(), codecs: z.string().optional(), label: z.string().optional(), mimeType: z.string().optional() });
export const SubtitleSchema = z.object({ url: z.string().url(), language: z.string().optional(), label: z.string().optional(), format: z.string().optional() });
export const SafeHeadersSchema = z.object({ contentType: z.string().optional(), contentLength: z.string().optional(), contentRange: z.string().optional(), contentDisposition: z.string().optional(), acceptRanges: z.string().optional(), etag: z.string().optional(), lastModified: z.string().optional() });
export const CandidateSchema = z.object({ id: z.string(), url: z.string(), finalUrl: z.string().optional(), pageUrl: z.string().optional(), referrer: z.string().optional(), source: CandidateSourceSchema, mediaType: MediaTypeSchema, mimeType: z.string().optional(), extension: z.string().optional(), filename: z.string().optional(), sizeBytes: z.number().int().nonnegative().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), durationSec: z.number().nonnegative().optional(), bitrate: z.number().int().positive().optional(), codecs: z.array(z.string()).optional(), variants: z.array(VariantSchema).optional(), subtitles: z.array(SubtitleSchema).optional(), headers: SafeHeadersSchema.optional(), drm: DrmInfoSchema.optional(), confidence: z.number().min(0).max(100),
  // Evidence trail: ordered list of observations that contributed to this candidate.
  // Optional for backward-compat; populated by the evidence engine going forward.
  evidence: z.array(EvidenceItemSchema).optional(),
  createdAt: z.string(), updatedAt: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional() });
export type Candidate = z.infer<typeof CandidateSchema>;
