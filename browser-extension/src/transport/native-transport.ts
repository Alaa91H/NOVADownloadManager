import browser from 'webextension-polyfill';
import { z } from 'zod';
import { NativeRequestSchema, NativeResponseSchema } from '../contracts/adm.protocol.v4';
import { AdmExtensionError, parseErrorBody, toAdmExtensionError } from '../core/error-classification';
import { assertNativeMessageBudget } from '../security/transport-payload-budget';
import { Transport } from './transport';

export class NativeTransport implements Transport {
  readonly id = 'native' as const;

  constructor(private readonly host = 'com.nova.downloadmanager') {}

  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.invoke('engine.status', {}, z.unknown());
      return response !== undefined;
    } catch {
      return false;
    }
  }

  async request<T>(method: string, payload: unknown, schema: z.ZodType<T>, _options?: { token?: string; method?: 'GET'|'POST' }): Promise<T> {
    return this.invoke(method, payload, schema);
  }

  async invoke<T>(method: string, params: unknown, resultSchema: z.ZodType<T>): Promise<T> {
    try {
      const request = NativeRequestSchema.parse({ id: crypto.randomUUID(), method, params });
      assertNativeMessageBudget(request, 'request');
      const raw = await browser.runtime.sendNativeMessage(this.host, request);
      assertNativeMessageBudget(raw, 'response');
      const response = NativeResponseSchema.parse(raw);
      if (!response.ok) {
        const parsed = parseErrorBody(response.error);
        throw new AdmExtensionError({ ...parsed, details: response.error });
      }
      return resultSchema.parse(response.result);
    } catch (error) {
      throw toAdmExtensionError(error, 'NATIVE_HOST_MISSING');
    }
  }

  async close(): Promise<void> {}
}
