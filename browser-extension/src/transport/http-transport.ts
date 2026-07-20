import { z } from 'zod';
import { NovaExtensionError, parseErrorBody, toNovaExtensionError } from '../core/error-classification';
import { Transport } from './transport';
import { DEFAULT_NOVA_LOOPBACK_HTTP_URL, buildNovaLoopbackHttpUrl, novaBaseUrlForPort } from './loopback-url-policy';
import { encodeJsonPayloadWithBudget, readJsonResponseWithBudget } from '../security/transport-payload-budget';

export type HttpTransportOptions = {
  token?: string;
  method?: 'GET' | 'POST';
  timeoutMs?: number;
};

const DEFAULT_PORT = 3199;
const PORT_SCAN_MAX = 10;
const PORT_DISCOVER_TIMEOUT_MS = 1_500;

export class HttpTransport implements Transport {
  readonly id = 'http' as const;
  private discoveredBaseUrl?: string;

  constructor(private readonly baseUrl = DEFAULT_NOVA_LOOPBACK_HTTP_URL) {}

  url(route: string): string {
    const base = this.discoveredBaseUrl ?? this.baseUrl;
    return buildNovaLoopbackHttpUrl(base, route);
  }

  async isAvailable(): Promise<boolean> {
    // Fast path: try the cached or default port first.
    if (this.discoveredBaseUrl) {
      if (await this.ping(this.discoveredBaseUrl)) return true;
      this.discoveredBaseUrl = undefined;
    }
    if (await this.ping(this.baseUrl)) return true;

    // Slow path: scan a range of ports in parallel.
    const found = await this.scanPorts();
    if (found) {
      this.discoveredBaseUrl = found;
      return true;
    }
    return false;
  }

  private async ping(baseUrl: string): Promise<boolean> {
    try {
      const pingUrl = buildNovaLoopbackHttpUrl(baseUrl, '/v1/ping');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PORT_DISCOVER_TIMEOUT_MS);
      try {
        const response = await fetch(pingUrl, { method: 'GET', cache: 'no-store', signal: controller.signal });
        return response.ok;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  }

  private async scanPorts(): Promise<string | null> {
    // Race all candidate ports but cancel the losers as soon as one responds,
    // so we never leave pending fetch connections hanging. Promise.any alone
    // resolves fast but leaves the remaining fetches running until timeout.
    const controller = new AbortController();
    const candidates: Array<Promise<string | null>> = [];
    for (let offset = 0; offset < PORT_SCAN_MAX; offset++) {
      const port = DEFAULT_PORT + offset;
      const base = novaBaseUrlForPort(port);
      candidates.push(
        this.pingWithSignal(base, controller.signal).then((ok) => (ok ? base : null)),
      );
    }
    try {
      const winner = await Promise.any(candidates);
      controller.abort();
      return winner;
    } catch {
      controller.abort();
      return null;
    }
  }

  private async pingWithSignal(baseUrl: string, externalSignal: AbortSignal): Promise<boolean> {
    try {
      const pingUrl = buildNovaLoopbackHttpUrl(baseUrl, '/v1/ping');
      const controller = new AbortController();
      // Cancel if either our own timeout or the external scan-cancel fires.
      const onExternalAbort = () => controller.abort();
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), PORT_DISCOVER_TIMEOUT_MS);
      try {
        const response = await fetch(pingUrl, { method: 'GET', cache: 'no-store', signal: controller.signal });
        return response.ok;
      } finally {
        clearTimeout(timeout);
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    } catch {
      return false;
    }
  }

  async request<T>(route: string, payload: unknown, schema: z.ZodType<T>, options: HttpTransportOptions = {}): Promise<T> {
    const method = options.method ?? (payload === undefined ? 'GET' : 'POST');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    try {
      const response = await fetch(this.url(route), {
        method,
        headers,
        cache: 'no-store',
        signal: controller.signal,
        body: method === 'POST' ? encodeJsonPayloadWithBudget(payload ?? {}) : undefined,
      });
      const data: unknown = await readJsonResponseWithBudget(response);
      if (!response.ok) {
        const parsed = parseErrorBody(data, response.status);
        throw new NovaExtensionError({ ...parsed, status: response.status });
      }
      return schema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new NovaExtensionError({ code: 'VALIDATION_FAILED', message: 'Response validation failed.', retryable: false, details: error.issues });
      }
      throw toNovaExtensionError(error, error instanceof DOMException && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally {
      clearTimeout(timeout);
    }
  }

  async close(): Promise<void> {}
}
