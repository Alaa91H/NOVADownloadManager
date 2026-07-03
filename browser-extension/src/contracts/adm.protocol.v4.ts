import { z } from 'zod';
import { CandidateSchema } from './candidate.schema';
import { CapabilitiesSchema } from './capabilities.schema';

export const ADM_PROTOCOL_VERSION = 4;

export const PingResponseSchema = z.object({
  ok: z.literal(true),
  app: z.string().default('ADM'),
  appVersion: z.string().default('unknown'),
  protocolVersion: z.number().int(),
  minimumSupportedProtocolVersion: z.number().int(),
  browserIntegrationEnabled: z.boolean().default(true),
});
export type PingResponse = z.infer<typeof PingResponseSchema>;

export const PairRequestSchema = z.object({
  clientId: z.string(),
  protocolVersion: z.literal(4),
  extensionOrigin: z.string(),
  trustedLocalOnly: z.literal(true),
  mode: z.literal('trusted-local-native-host'),
  requireLocalhost: z.literal(true),
  allowUserPrompt: z.literal(false),
  silent: z.literal(true),
  zeroClick: z.literal(true),
});

export const PairResponseSchema = z.object({
  ok: z.literal(true),
  pairToken: z.string().min(24),
  autoApproved: z.boolean().default(true),
  method: z.string().default('auto'),
  protocolVersion: z.number().int(),
  minimumSupportedProtocolVersion: z.number().int(),
  ttlSeconds: z.number().int().positive().optional(),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

export const AuthCheckResponseSchema = z.object({
  ok: z.literal(true),
  protocolVersion: z.number().int(),
  minimumSupportedProtocolVersion: z.number().int(),
  scopes: z.array(z.string()).default([]),
});

export const ExtensionSettingsResponseSchema = z.object({
  ok: z.boolean().default(true),
  capabilities: CapabilitiesSchema.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const AddTaskRequestSchema = z.object({
  idempotencyKey: z.string().min(16),
  candidate: CandidateSchema,
  source: z.literal('adm-extension'),
});

export const AddBatchRequestSchema = z.object({
  idempotencyKey: z.string().min(16),
  candidates: z.array(CandidateSchema).min(1),
  source: z.literal('adm-extension'),
});

export const AddTaskResponseSchema = z.object({
  ok: z.boolean(),
  taskId: z.string().optional(),
  taskIds: z.array(z.string()).optional(),
  accepted: z.boolean().default(true),
  duplicate: z.boolean().optional(),
  message: z.string().optional(),
});
export type AddTaskResponse = z.infer<typeof AddTaskResponseSchema>;

export const TaskCommandResponseSchema = z.object({ ok: z.boolean(), taskId: z.string().optional(), message: z.string().optional() });
export const TaskListResponseSchema = z.object({ ok: z.boolean().default(true), tasks: z.array(z.record(z.string(), z.unknown())).default([]) });

export const NativeRequestSchema = z.object({ id: z.string(), method: z.string(), params: z.unknown().optional() });
export const NativeResponseSchema = z.object({ id: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.unknown().optional() });

// ---------------------------------------------------------------------------
// Phase 6: Stream Manifest Contract
// The extension detects HLS/DASH manifests and sends them as stream.manifest
// candidates. ADM Desktop owns all downloading, segment fetching, and quality
// selection. The extension NEVER downloads HLS/DASH segments.
// ---------------------------------------------------------------------------

export const StreamManifestResolverSchema = z.object({
  preferred: z.literal('desktop'),
  canRefresh: z.boolean(),
  canMerge: z.boolean(),
  canSelectQuality: z.boolean(),
});

export const StreamManifestCandidateSchema = z.object({
  kind: z.literal('stream.manifest'),
  manifestType: z.enum(['hls', 'dash']),
  url: z.string().url(),
  pageUrl: z.string().optional(),
  referrer: z.string().optional(),
  // Only safe headers; never Authorization or Cookie
  headers: z.object({
    contentType: z.string().optional(),
    contentLength: z.string().optional(),
  }).optional(),
  detectedBy: z.array(z.string()).default([]),
  evidence: z.array(z.unknown()).default([]),
  drmProtected: z.boolean().default(false),
  resolver: StreamManifestResolverSchema,
});
export type StreamManifestCandidate = z.infer<typeof StreamManifestCandidateSchema>;

export const StreamResolveRequestSchema = z.object({
  manifestType: z.enum(['hls', 'dash']),
  url: z.string().url(),
  pageUrl: z.string().optional(),
});

export const StreamQualitySchema = z.object({
  url: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bandwidth: z.number().int().positive().optional(),
  codecs: z.string().optional(),
  label: z.string().optional(),
  // IDM-style per-quality details (provided by ADM when it resolves the manifest):
  estimatedSizeBytes: z.number().int().nonnegative().optional(),
  container: z.string().optional(),   // e.g. 'mp4', 'webm', 'ts'
  fps: z.number().positive().optional(),
  hasAudio: z.boolean().optional(),
  hasVideo: z.boolean().optional(),
});

export const StreamResolveResponseSchema = z.object({
  ok: z.boolean(),
  manifestType: z.enum(['hls', 'dash']).optional(),
  qualities: z.array(StreamQualitySchema).default([]),
  durationSec: z.number().nonnegative().optional(),
  isLive: z.boolean().optional(),
  drmProtected: z.boolean().default(false),
  subtitleTracks: z.array(z.object({ language: z.string().optional(), label: z.string().optional() })).default([]),
  audioTracks: z.array(z.object({ language: z.string().optional(), label: z.string().optional() })).default([]),
  estimatedSizeBytes: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
});
export type StreamResolveResponse = z.infer<typeof StreamResolveResponseSchema>;

export const StreamAddRequestSchema = z.object({
  idempotencyKey: z.string().min(16),
  manifest: StreamManifestCandidateSchema,
  selectedQuality: StreamQualitySchema.optional(),
  source: z.literal('adm-extension'),
});
