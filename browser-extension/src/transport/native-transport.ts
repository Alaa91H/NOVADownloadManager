import browser from 'webextension-polyfill';
import { z } from 'zod';
import { NativeRequestSchema, NativeResponseSchema } from '../contracts/nova.protocol.v4';
import { NovaExtensionError, parseErrorBody, toNovaExtensionError } from '../core/error-classification';
import { assertNativeMessageBudget } from '../security/transport-payload-budget';
import { Transport } from './transport';

/** sendNativeMessage has no built-in timeout: a hung or slow-starting host
 *  would otherwise stall discovery (and with it the whole connect flow)
 *  indefinitely. */
const NATIVE_INVOKE_TIMEOUT_MS = 10_000;
const NATIVE_PROBE_TIMEOUT_MS = 6_000;

export class NativeTransport implements Transport {
  readonly id = 'native' as const;

  constructor(private readonly host = 'com.nova.downloadmanager') {}

  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.invoke('engine.status', {}, z.unknown(), NATIVE_PROBE_TIMEOUT_MS);
      return response !== undefined;
    } catch {
      return false;
    }
  }

  async request<T>(method: string, payload: unknown, schema: z.ZodType<T>, _options?: { token?: string; method?: 'GET'|'POST' }): Promise<T> {
    return this.invoke(method, payload, schema);
  }

  async invoke<T>(method: string, params: unknown, resultSchema: z.ZodType<T>, timeoutMs = NATIVE_INVOKE_TIMEOUT_MS): Promise<T> {
    try {
      const request = NativeRequestSchema.parse({ id: crypto.randomUUID(), method, params });
      assertNativeMessageBudget(request, 'request');
      const raw = await Promise.race([
        browser.runtime.sendNativeMessage(this.host, request),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('native host response timed out')), timeoutMs);
        }),
      ]);
      assertNativeMessageBudget(raw, 'response');
      const response = NativeResponseSchema.parse(raw);
      if (!response.ok) {
        const parsed = parseErrorBody(response.error);
        throw new NovaExtensionError({ ...parsed, details: response.error });
      }
      return resultSchema.parse(response.result);
    } catch (error) {
      throw toNovaExtensionError(error, 'NATIVE_HOST_MISSING');
    }
  }

  async close(): Promise<void> {}
}
