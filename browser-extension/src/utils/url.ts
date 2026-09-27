const TRACKING = new Set(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','mc_cid','mc_eid','igshid','msclkid']);
const SIGNED_QUERY_PREFIXES = ['x-amz-', 'x-goog-', 'x-oss-'];
const SIGNED_QUERY_KEYS = new Set(['sig', 'signature', 'token', 'expires', 'expiresignature', 'policy', 'credential', 'key-pair-id']);

function isSignedQueryKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SIGNED_QUERY_KEYS.has(lower) || SIGNED_QUERY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function normalizeUrl(input: string): string {
  if (input.startsWith('magnet:?')) return input;
  try {
    const u = new URL(input);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    let hasSignedParams = false;
    for (const key of u.searchParams.keys()) {
      if (isSignedQueryKey(key)) {
        hasSignedParams = true;
        break;
      }
    }
    if (!hasSignedParams) {
      for (const key of [...u.searchParams.keys()]) if (TRACKING.has(key.toLowerCase())) u.searchParams.delete(key);
    } else {
      // Signed URLs are security-sensitive and often query-order-sensitive. Keep the query intact.
      for (const key of [...u.searchParams.keys()]) if (TRACKING.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    u.hash = '';
    return u.toString();
  } catch {
    return input;
  }
}

export function extensionOf(url: string): string | undefined {
  if (url.startsWith('magnet:?')) return 'magnet';
  try {
    const p = new URL(url).pathname;
    const m = /\.([a-z0-9]{1,10})$/i.exec(p);
    return m?.[1]?.toLowerCase();
  } catch {
    const m = /\.([a-z0-9]{1,10})(?:$|[?#])/i.exec(url);
    return m?.[1]?.toLowerCase();
  }
}

const SAFE_PROTOCOLS = /^(https?|magnet|blob|data):/i;

export function safeAbsoluteUrl(raw: string, base?: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('javascript:') || trimmed.startsWith('#')) return undefined;
  try {
    if (SAFE_PROTOCOLS.test(trimmed)) return trimmed;
    if (trimmed.startsWith('//')) return new URL(trimmed, base ?? 'https:').toString();
    return new URL(trimmed, base).toString();
  } catch {
    return undefined;
  }
}

export function safeDisplayUrl(input: string, maxLength = 96): string {
  try {
    if (input.startsWith('magnet:?')) return input.length > maxLength ? `${input.slice(0, maxLength)}…` : input;
    const url = new URL(input);
    for (const key of [...url.searchParams.keys()]) {
      if (isSignedQueryKey(key) || /token|secret|auth|session|signature/i.test(key)) url.searchParams.set(key, 'REDACTED');
    }
    const out = url.toString();
    return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
  } catch {
    return input.length > maxLength ? `${input.slice(0, maxLength)}…` : input;
  }
}
