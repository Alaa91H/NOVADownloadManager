import { z } from 'zod';

export const DrmSystemSchema = z.enum(['widevine', 'playready', 'fairplay', 'clearkey', 'unknown']);
export type DrmSystem = z.infer<typeof DrmSystemSchema>;

export const DrmProtectionSchemeSchema = z.enum(['cenc', 'cbcs', 'cens', 'cbc1', 'unknown']);
export type DrmProtectionScheme = z.infer<typeof DrmProtectionSchemeSchema>;

export const DrmDetectionSourceSchema = z.enum([
  'eme',
  'encrypted-event',
  'dash-manifest',
  'hls-manifest',
  'init-segment',
  'html-keyword',
  'headers',
  'unknown',
]);
export type DrmDetectionSource = z.infer<typeof DrmDetectionSourceSchema>;

export const DrmInfoSchema = z.object({
  protected: z.boolean().default(false),
  system: DrmSystemSchema.optional(),
  keySystem: z.string().trim().min(1).max(128).optional(),
  scheme: DrmProtectionSchemeSchema.optional(),
  source: DrmDetectionSourceSchema.default('unknown'),
  initDataType: z.string().trim().min(1).max(64).optional(),
  psshCount: z.number().int().nonnegative().max(10_000).optional(),
  licenseRequestObserved: z.boolean().default(false).optional(),
  downloadable: z.boolean().default(true),
  reason: z.string().trim().min(1).max(240),
});
export type DrmInfo = z.infer<typeof DrmInfoSchema>;

export const DrmIndicatorsSchema = z.object({
  likelyProtected: z.boolean().default(false),
  systems: z.array(DrmSystemSchema).default([]),
  keySystems: z.array(z.string().trim().min(1).max(128)).default([]),
  emeKeywords: z.array(z.string().trim().min(1).max(128)).default([]),
  mediaKeysDetected: z.boolean().default(false),
  encryptedMediaEventHint: z.boolean().default(false),
  contentProtectionDetected: z.boolean().default(false),
  hlsKeyDetected: z.boolean().default(false),
  psshCount: z.number().int().nonnegative().max(10_000).default(0),
  scheme: DrmProtectionSchemeSchema.optional(),
  initDataTypes: z.array(z.string().trim().min(1).max(64)).default([]),
  sources: z.array(DrmDetectionSourceSchema).default([]),
  reason: z.string().trim().min(1).max(240).optional(),
});
export type DrmIndicators = z.infer<typeof DrmIndicatorsSchema>;

export const defaultDrmIndicators: DrmIndicators = DrmIndicatorsSchema.parse({});
