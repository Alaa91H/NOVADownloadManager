import { NovaExtensionError } from '../core/error-classification';

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const NOVA_DEFAULT_PORT = 3199;
const NOVA_PORT_SCAN_MAX = 10;

export const DEFAULT_NOVA_LOOPBACK_HTTP_URL = 'http://127.0.0.1:3199';
export const DEFAULT_NOVA_LOOPBACK_WS_URL = 'ws://127.0.0.1:3199';

function invalidLoopback(message: string, details?: Record<string, unknown>): never {
  throw new NovaExtensionError({
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

function isNovaPort(port: string): boolean {
  const num = Number(port);
  return Number.isFinite(num) && num >= NOVA_DEFAULT_PORT && num < NOVA_DEFAULT_PORT + NOVA_PORT_SCAN_MAX;
}

export function assertNovaLoopbackOrigin(url: string | URL, expectedProtocol: 'http:' | 'ws:'): URL {
  const parsed = typeof url === 'string' ? parseUrl(url, expectedProtocol === 'http:' ? 'http' : 'ws') : url;
  if (parsed.protocol !== expectedProtocol) {
    invalidLoopback('NOVA loopback URL uses an unexpected protocol.', { protocol: parsed.protocol, expectedProtocol });
  }
  if (!ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname)) {
    invalidLoopback('NOVA loopback URL must target localhost only.', { hostname: parsed.hostname });
  }
  if (!isNovaPort(parsed.port || '3199')) {
    invalidLoopback('NOVA loopback URL must use a valid NOVA daemon port (3199-3208).', { port: parsed.port });
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

export function buildNovaLoopbackHttpUrl(baseUrl: string, route: string): string {
  const base = assertNovaLoopbackOrigin(baseUrl, 'http:');
  const safeRoute = assertSafeLoopbackRoute(route);
  const url = new URL(safeRoute, base.origin);
  assertNovaLoopbackOrigin(url, 'http:');
  return url.toString();
}

export function assertNovaLoopbackHttpUrl(url: string): string {
  const parsed = assertNovaLoopbackOrigin(url, 'http:');
  return parsed.toString();
}

export function assertNovaLoopbackWsUrl(url: string): string {
  const parsed = assertNovaLoopbackOrigin(url, 'ws:');
  return parsed.toString();
}

export function novaBaseUrlForPort(port: number): string {
  return `http://127.0.0.1:${port}`;
}
