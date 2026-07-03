const SECRET_KEYS = /(authorization|token|cookie|set-cookie|pairToken|bearer|signature|sig|key|secret|credential|password|session|jwt|auth)/i;
const SENSITIVE_QUERY_KEYS = /(token|access_token|auth|authorization|sig|signature|key|api_key|apikey|expires|x-amz-|x-goog-|policy|credential|session|jwt|secret)/i;

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = SECRET_KEYS.test(key) ? '[REDACTED]' : redact(nested);
    return out;
  }
  return value;
}

export function redactString(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&])([^=&#\s]+)=([^&#\s]+)/g, (match, prefix: string, rawKey: string) => {
      let key: string;
      try { key = decodeURIComponent(rawKey); } catch { key = rawKey; }
      return SENSITIVE_QUERY_KEYS.test(key) ? `${prefix}${rawKey}=[REDACTED]` : match;
    });
}

export function redactUrl(input: string): string {
  if (!input) return input;
  try {
    const url = new URL(input);
    if ([...url.searchParams.keys()].some((k) => SENSITIVE_QUERY_KEYS.test(k))) {
      return `${url.origin}${url.pathname}?redacted`;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return input;
  }
}

export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_KEYS.test(key) ? '[REDACTED]' : value;
  }
  return out;
}
