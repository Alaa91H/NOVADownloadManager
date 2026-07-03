import { AdmExtensionError } from '../core/error-classification';

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const ADM_LOOPBACK_PORT = '3199';

export const DEFAULT_ADM_LOOPBACK_HTTP_URL = 'http://127.0.0.1:3199';
export const DEFAULT_ADM_LOOPBACK_WS_URL = 'ws://127.0.0.1:3199';

function invalidLoopback(message: string, details?: Record<string, unknown>): never {
  throw new AdmExtensionError({
    code: 'VALIDATION_FAILED',
    message,
    retryable: false,
    repairHint: 'Use the official NOVA loopback endpoint on 127.0.0.1:3199.',
    details,
  });
}

function parseUrl(value: string, kind: 'http' | 'ws'): URL {
  try {
    return new URL(value);
  } catch {
    invalidLoopback(`Invalid NOVA ${kind.toUpperCase()} loopback URL.`, { value });
  }
}

export function assertAdmLoopbackOrigin(url: string | URL, expectedProtocol: 'http:' | 'ws:'): URL {
  const parsed = typeof url === 'string' ? parseUrl(url, expectedProtocol === 'http:' ? 'http' : 'ws') : url;
  if (parsed.protocol !== expectedProtocol) {
    invalidLoopback('NOVA loopback URL uses an unexpected protocol.', { protocol: parsed.protocol, expectedProtocol });
  }
  if (!ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname)) {
    invalidLoopback('NOVA loopback URL must target localhost only.', { hostname: parsed.hostname });
  }
  if (parsed.port !== ADM_LOOPBACK_PORT) {
    invalidLoopback('NOVA loopback URL must use the official NOVA browser integration port.', { port: parsed.port });
  }
  if (parsed.username || parsed.password) {
    invalidLoopback('NOVA loopback URL must not include credentials.');
  }
  return parsed;
}

function hasNullByte(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 0) return true;
  }
  return false;
}

export function assertSafeLoopbackRoute(route: string): string {
  if (!route.startsWith('/')) invalidLoopback('NOVA route must be path-relative and start with /.', { route });
  if (/^[a-z][a-z0-9+.-]*:/i.test(route)) invalidLoopback('NOVA route must not be an absolute URL.', { route });
  if (/\\|[\r\n]/.test(route) || hasNullByte(route)) invalidLoopback('NOVA route contains unsafe characters.', { route });
  if (route.includes('..')) invalidLoopback('NOVA route must not contain parent-directory traversal.', { route });
  return route;
}

export function buildAdmLoopbackHttpUrl(baseUrl: string, route: string): string {
  const base = assertAdmLoopbackOrigin(baseUrl, 'http:');
  const safeRoute = assertSafeLoopbackRoute(route);
  const url = new URL(safeRoute, base.origin);
  assertAdmLoopbackOrigin(url, 'http:');
  return url.toString();
}

export function assertAdmLoopbackHttpUrl(url: string): string {
  const parsed = assertAdmLoopbackOrigin(url, 'http:');
  return parsed.toString();
}

export function assertAdmLoopbackWsUrl(url: string): string {
  const parsed = assertAdmLoopbackOrigin(url, 'ws:');
  return parsed.toString();
}
