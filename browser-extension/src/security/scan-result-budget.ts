import type { ContentScanResponse } from '../contracts/messages.schema';
import { ContentScanResponseSchema } from '../contracts/messages.schema';
import {
  AGGRESSIVE_MAX_SCAN_HTML_CHARS,
  AGGRESSIVE_MAX_SCAN_JSON_LD_ITEMS,
  AGGRESSIVE_MAX_SCAN_JSON_LD_TOTAL_CHARS,
  AGGRESSIVE_MAX_SCAN_LINKS,
  AGGRESSIVE_MAX_SCAN_MEDIA,
  AGGRESSIVE_MAX_SCAN_OPEN_GRAPH,
  MAX_SCAN_HTML_CHARS,
  MAX_SCAN_JSON_LD_ITEMS,
  MAX_SCAN_JSON_LD_TOTAL_CHARS,
  MAX_SCAN_LINKS,
  MAX_SCAN_MEDIA,
  MAX_SCAN_OPEN_GRAPH,
} from '../contracts/limits';

export type ScanBudgetProfile = 'standard' | 'aggressive';

function jsonByteLength(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).length; } catch { return Number.POSITIVE_INFINITY; }
}

function budgetFor(profile: ScanBudgetProfile) {
  return profile === 'aggressive' ? {
    maxHtmlChars: AGGRESSIVE_MAX_SCAN_HTML_CHARS,
    maxLinks: AGGRESSIVE_MAX_SCAN_LINKS,
    maxMedia: AGGRESSIVE_MAX_SCAN_MEDIA,
    maxOpenGraph: AGGRESSIVE_MAX_SCAN_OPEN_GRAPH,
    maxJsonLdItems: AGGRESSIVE_MAX_SCAN_JSON_LD_ITEMS,
    maxJsonLdTotalChars: AGGRESSIVE_MAX_SCAN_JSON_LD_TOTAL_CHARS,
  } : {
    maxHtmlChars: MAX_SCAN_HTML_CHARS,
    maxLinks: MAX_SCAN_LINKS,
    maxMedia: MAX_SCAN_MEDIA,
    maxOpenGraph: MAX_SCAN_OPEN_GRAPH,
    maxJsonLdItems: MAX_SCAN_JSON_LD_ITEMS,
    maxJsonLdTotalChars: MAX_SCAN_JSON_LD_TOTAL_CHARS,
  };
}

function trimJsonLd(items: unknown[], profile: ScanBudgetProfile): unknown[] {
  const budget = budgetFor(profile);
  const out: unknown[] = [];
  let total = 0;
  for (const item of items.slice(0, budget.maxJsonLdItems)) {
    const bytes = jsonByteLength(item);
    if (!Number.isFinite(bytes)) continue;
    if (total + bytes > budget.maxJsonLdTotalChars) break;
    total += bytes;
    out.push(item);
  }
  return out;
}


// Standard budget guard strings retained for regression tests:
// links: parsed.links.slice(0, MAX_SCAN_LINKS)
// media: parsed.media.slice(0, MAX_SCAN_MEDIA)
// openGraph: parsed.openGraph.slice(0, MAX_SCAN_OPEN_GRAPH)
// jsonLd: trimJsonLd(parsed.jsonLd)

export function enforceContentScanBudget(input: unknown, profile: ScanBudgetProfile = 'standard'): ContentScanResponse {
  const parsed = ContentScanResponseSchema.parse(input);
  const budget = budgetFor(profile);
  return ContentScanResponseSchema.parse({
    ...parsed,
    html: parsed.html.slice(0, budget.maxHtmlChars),
    links: parsed.links.slice(0, budget.maxLinks),
    media: parsed.media.slice(0, budget.maxMedia),
    openGraph: parsed.openGraph.slice(0, budget.maxOpenGraph),
    jsonLd: trimJsonLd(parsed.jsonLd, profile),
  });
}
