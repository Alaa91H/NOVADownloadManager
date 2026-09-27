import { z } from 'zod';
import { MediaTypeSchema } from '../contracts/candidate.schema';
import { MAX_SITE_RULE_HOST_CHARS, MAX_SITE_RULE_PATTERN_CHARS, MAX_SITE_RULE_PATTERNS } from '../contracts/limits';

export const SiteRuleSchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1).max(MAX_SITE_RULE_HOST_CHARS),
  enabled: z.boolean(),
  autoCapture: z.boolean(),
  askBeforeSend: z.boolean(),
  mediaTypes: z.array(MediaTypeSchema.exclude(['manifest', 'other'])).min(1),
  minSizeMB: z.number().nonnegative(),
  includePatterns: z.array(z.string().max(MAX_SITE_RULE_PATTERN_CHARS)).max(MAX_SITE_RULE_PATTERNS),
  excludePatterns: z.array(z.string().max(MAX_SITE_RULE_PATTERN_CHARS)).max(MAX_SITE_RULE_PATTERNS),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SiteRule = z.infer<typeof SiteRuleSchema>;

export function createDefaultSiteRule(host: string, now = new Date().toISOString()): SiteRule {
  const normalizedHost = host.trim().toLowerCase();
  return SiteRuleSchema.parse({
    id: crypto.randomUUID(),
    host: normalizedHost,
    enabled: true,
    autoCapture: false,
    askBeforeSend: true,
    mediaTypes: ['video', 'audio', 'image', 'document', 'archive', 'app', 'torrent', 'magnet'],
    minSizeMB: 1,
    includePatterns: [],
    excludePatterns: ['*://*/favicon.*', '*://*/pixel*', '*://*/analytics*'],
    createdAt: now,
    updatedAt: now,
  });
}
