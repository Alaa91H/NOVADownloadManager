const HEADER_VALUE_LIMIT = 4096;

export function normalizeSafeHeaderValue(value: string): string | undefined {
  const normalized = value.replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, HEADER_VALUE_LIMIT);
}
