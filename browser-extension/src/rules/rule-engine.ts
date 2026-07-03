import { Candidate } from '../contracts/candidate.schema';
import { SiteRule } from './site-rules';

export class RuleEngine {
  constructor(private readonly rules: SiteRule[] = []) {}

  forHost(host: string): SiteRule[] {
    return this.rules.filter((rule) => rule.enabled && hostMatches(rule.host, host));
  }

  shouldShow(candidate: Candidate): boolean {
    const host = hostOf(candidate.pageUrl ?? candidate.url);
    const rule = host ? this.forHost(host)[0] : undefined;
    if (!rule) return true;
    if (!rule.mediaTypes.some((type) => type === candidate.mediaType)) return false;
    if ((candidate.sizeBytes ?? 0) < rule.minSizeMB * 1024 * 1024) return false;
    if (rule.includePatterns.length > 0 && !rule.includePatterns.some((pattern) => wildcard(pattern, candidate.url))) return false;
    if (rule.excludePatterns.some((pattern) => wildcard(pattern, candidate.url))) return false;
    return true;
  }

  shouldAutoSend(candidate: Candidate): boolean {
    const host = hostOf(candidate.pageUrl ?? candidate.url);
    const rule = host ? this.forHost(host)[0] : undefined;
    return Boolean(rule?.autoCapture && !rule.askBeforeSend && this.shouldShow(candidate));
  }
}

function hostOf(url: string): string | undefined {
  try { return new URL(url).host; } catch { return undefined; }
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith(`.${pattern.slice(2)}`);
  return false;
}

function wildcard(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}
