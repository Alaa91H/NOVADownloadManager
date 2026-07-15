import { z } from 'zod';
import { NovaExtensionError, parseErrorBody, toNovaExtensionError } from '../core/error-classification';
import { Transport } from './transport';
import { DEFAULT_NOVA_LOOPBACK_HTTP_URL, buildNovaLoopbackHttpUrl } from './loopback-url-policy';
import { encodeJsonPayloadWithBudget, readJsonResponseWithBudget } from '../security/transport-payload-budget';

export type HttpTransportOptions = {
  token?: string;
  method?: 'GET' | 'POST';
  timeoutMs?: number;
};

export class HttpTransport implements Transport {
  readonly id = 'http' as const;

  constructor(private readonly baseUrl = DEFAULT_NOVA_LOOPBACK_HTTP_URL) {}

  url(route: string): string {
    return buildNovaLoopbackHttpUrl(this.baseUrl, route);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(this.url('/v1/ping'), { method: 'GET', cache: 'no-store' });
      return response.ok;
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
