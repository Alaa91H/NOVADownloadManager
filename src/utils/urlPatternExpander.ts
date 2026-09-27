/**
 * URL pattern expansion — mirrors IDM/FDM batch URL syntax.
 *
 * Supported patterns:
 *   file[1-10].zip        → file1.zip … file10.zip
 *   file[01-10].zip       → file01.zip … file10.zip (zero-padded)
 *   img[a-c].png          → imga.png, imgb.png, imgc.png
 *   file[1-3]_[a-b].zip   → file1_a.zip, file1_b.zip, file2_a.zip, …
 *   file[1-10:2].zip      → file1.zip, file3.zip, file5.zip, … (step=2)
 *
 * Expansion is hard-capped at {@link MAX_EXPANDED_URLS} so adversarial or
 * accidental inputs (e.g. `file[1-999999999].zip`) fail fast with a
 * RangeError instead of freezing the UI thread or exhausting memory.
 * The count-only API (countUrlPattern / countUrlList) mirrors the expand
 * API's cap semantics without allocating any URL strings.
 */

const BRACKET_RE = /\[([^\]]+)\]/g;

/** Maximum number of concrete URLs a single expansion may produce. */
export const MAX_EXPANDED_URLS = 10_000;

type Bracket =
  | { type: 'literal'; value: string }
  | { type: 'numeric'; low: number; high: number; step: number; padWidth: number }
  | { type: 'alpha'; low: number; high: number; step: number };

interface BracketGroup {
  prefix: string;
  bracket: Bracket;
}

/** Parse a bracket like "1-10", "01-10", "a-z", "1-10:2" into a descriptor. */
function parseBracket(raw: string): Bracket {
  let step = 1;
  const stepIdx = raw.lastIndexOf(':');
  if (stepIdx !== -1) {
    const parsed = parseInt(raw.slice(stepIdx + 1), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      step = parsed;
      raw = raw.slice(0, stepIdx);
    }
  }

  const dashIdx = raw.indexOf('-');
  if (dashIdx === -1) return { type: 'literal', value: raw };

  const startStr = raw.slice(0, dashIdx);
  const endStr = raw.slice(dashIdx + 1);

  const startNum = parseInt(startStr, 10);
  const endNum = parseInt(endStr, 10);

  if (!Number.isNaN(startNum) && !Number.isNaN(endNum)) {
    return {
      type: 'numeric',
      low: Math.min(startNum, endNum),
      high: Math.max(startNum, endNum),
      step,
      padWidth: Math.max(startStr.length, endStr.length),
    };
  }

  if (startStr.length === 1 && endStr.length === 1) {
    return {
      type: 'alpha',
      low: Math.min(startStr.charCodeAt(0), endStr.charCodeAt(0)),
      high: Math.max(startStr.charCodeAt(0), endStr.charCodeAt(0)),
      step,
    };
  }

  return { type: 'literal', value: raw };
}

/** Split a URL into its bracket groups plus the trailing literal. */
function parsePattern(url: string): { groups: BracketGroup[]; trailing: string } {
  const groups: BracketGroup[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  BRACKET_RE.lastIndex = 0;
  while ((m = BRACKET_RE.exec(url)) !== null) {
    groups.push({ prefix: url.slice(cursor, m.index), bracket: parseBracket(m[1]) });
    cursor = m.index + m[0].length;
  }
  return { groups, trailing: url.slice(cursor) };
}

/** How many values a bracket would produce, computed without allocating. */
function bracketCount(b: Bracket): number {
  switch (b.type) {
    case 'literal':
      return 1;
    case 'numeric':
    case 'alpha':
      return Math.floor((b.high - b.low) / b.step) + 1;
  }
}

/** Materialize the values a bracket produces. Caller must have checked the cap. */
function bracketValues(b: Bracket): string[] {
  switch (b.type) {
    case 'literal':
      return [b.value];
    case 'numeric': {
      const results: string[] = [];
      for (let i = b.low; i <= b.high; i += b.step) results.push(String(i).padStart(b.padWidth, '0'));
      return results;
    }
    case 'alpha': {
      const results: string[] = [];
      for (let c = b.low; c <= b.high; c += b.step) results.push(String.fromCharCode(c));
      return results;
    }
  }
}

/** Throw the shared cap-exceeded error. */
function expansionTooLarge(): never {
  throw new RangeError(`Pattern expands to too many URLs (max ${String(MAX_EXPANDED_URLS)})`);
}

/**
 * Size of the cartesian product for a pattern's groups, throwing when it
 * exceeds the cap. The product is checked without allocating so a huge range
 * like `[1-999999999]` bails immediately.
 */
function patternCount(groups: BracketGroup[]): number {
  let total = 1;
  for (const g of groups) {
    const count = bracketCount(g.bracket);
    if (count > MAX_EXPANDED_URLS || total > MAX_EXPANDED_URLS / count) expansionTooLarge();
    total *= count;
  }
  return total;
}

/** Expand a URL containing [range] patterns into a list of concrete URLs. */
export function expandUrlPattern(url: string): string[] {
  if (!url.includes('[')) return [url];

  const { groups, trailing } = parsePattern(url);
  if (groups.length === 0) return [url];

  patternCount(groups); // throws when the cap is exceeded

  // Cartesian product
  let results: string[] = [''];
  for (const g of groups) {
    const next: string[] = [];
    const values = bracketValues(g.bracket);
    for (const base of results) for (const v of values) next.push(base + g.prefix + v);
    results = next;
  }
  return results.map((r) => r + trailing);
}

/** Number of URLs a pattern would produce, without allocating them. */
export function countUrlPattern(url: string): number {
  if (!url.includes('[')) return 1;
  const { groups } = parsePattern(url);
  if (groups.length === 0) return 1;
  return patternCount(groups);
}

/** Expand multiple URLs (one per line), each possibly containing patterns. */
export function expandUrlList(input: string): string[] {
  const out: string[] = [];
  let total = 0;
  for (const line of input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const expanded = expandUrlPattern(line);
    if (total + expanded.length > MAX_EXPANDED_URLS) expansionTooLarge();
    total += expanded.length;
    out.push(...expanded);
  }
  return out;
}

export interface DeduplicatedUrlList {
  /** Concrete URLs in first-seen order. */
  urls: string[];
  /** Number of repeated concrete URLs omitted from {@link urls}. */
  duplicateCount: number;
}

/**
 * Remove exact repeated URLs while preserving the first occurrence of each URL.
 *
 * This deliberately runs after pattern expansion. It does not rewrite or
 * canonicalize URLs, so signed URLs and case-sensitive paths retain their
 * semantics; it only prevents identical concrete requests from entering the
 * same batch more than once.
 */
export function deduplicateUrlList(urls: readonly string[]): DeduplicatedUrlList {
  const seen = new Set<string>();
  const unique: string[] = [];
  let duplicateCount = 0;

  for (const url of urls) {
    if (seen.has(url)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(url);
    unique.push(url);
  }

  return { urls: unique, duplicateCount };
}

/** Number of URLs a multi-line batch would produce, without allocating them. */
export function countUrlList(input: string): number {
  let total = 0;
  for (const line of input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const count = countUrlPattern(line);
    if (total + count > MAX_EXPANDED_URLS) expansionTooLarge();
    total += count;
  }
  return total;
}
