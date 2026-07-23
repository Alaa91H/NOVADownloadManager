/**
 * URL pattern expansion — mirrors IDM/FDM batch URL syntax.
 *
 * Supported patterns:
 *   file[1-10].zip        → file1.zip … file10.zip
 *   file[01-10].zip       → file01.zip … file10.zip (zero-padded)
 *   img[a-c].png          → imga.png, imgb.png, imgc.png
 *   file[1-3]_[a-b].zip   → file1_a.zip, file1_b.zip, file2_a.zip, …
 *   file[1-10:2].zip      → file1.zip, file3.zip, file5.zip, … (step=2)
 */

const BRACKET_RE = /\[([^\]]+)\]/g;

/** Parse a bracket like "1-10", "01-10", "a-z", "1-10:2" into replacement strings. */
function expandBracket(raw: string): string[] {
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
  if (dashIdx === -1) return [raw];

  const startStr = raw.slice(0, dashIdx);
  const endStr = raw.slice(dashIdx + 1);

  const startNum = parseInt(startStr, 10);
  const endNum = parseInt(endStr, 10);

  if (!Number.isNaN(startNum) && !Number.isNaN(endNum)) {
    const padWidth = Math.max(startStr.length, endStr.length);
    const results: string[] = [];
    for (let i = Math.min(startNum, endNum); i <= Math.max(startNum, endNum); i += step) {
      results.push(String(i).padStart(padWidth, '0'));
    }
    return results;
  }

  if (startStr.length === 1 && endStr.length === 1) {
    const low = Math.min(startStr.charCodeAt(0), endStr.charCodeAt(0));
    const high = Math.max(startStr.charCodeAt(0), endStr.charCodeAt(0));
    const results: string[] = [];
    for (let c = low; c <= high; c += step) results.push(String.fromCharCode(c));
    return results;
  }

  return [raw];
}

/** Expand a URL containing [range] patterns into a list of concrete URLs. */
export function expandUrlPattern(url: string): string[] {
  if (!url.includes('[')) return [url];

  const groups: { prefix: string; values: string[] }[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  BRACKET_RE.lastIndex = 0;
  while ((m = BRACKET_RE.exec(url)) !== null) {
    groups.push({ prefix: url.slice(cursor, m.index), values: expandBracket(m[1]) });
    cursor = m.index + m[0].length;
  }
  const trailing = url.slice(cursor);

  if (groups.length === 0) return [url];

  // Cartesian product
  let results: string[] = [''];
  for (const g of groups) {
    const next: string[] = [];
    for (const base of results) for (const v of g.values) next.push(base + g.prefix + v);
    results = next;
  }
  return results.map((r) => r + trailing);
}

/** Expand multiple URLs (one per line), each possibly containing patterns. */
export function expandUrlList(input: string): string[] {
  const out: string[] = [];
  for (const line of input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    out.push(...expandUrlPattern(line));
  }
  return out;
}
