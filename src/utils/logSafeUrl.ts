/**
 * Produce a stable, non-secret diagnostic label for a user-supplied URL.
 *
 * Download links commonly contain short-lived signed query parameters. Logs
 * must never persist their path, query, fragment, or embedded credentials;
 * the origin is sufficient to correlate connectivity failures safely.
 */
export function logSafeUrlOrigin(value: string): string {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'unsupported-url';
    return parsed.origin;
  } catch {
    return 'invalid-url';
  }
}
