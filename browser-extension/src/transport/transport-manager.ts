import { z } from 'zod';
import { NativeTransport } from './native-transport';
import { HttpTransport, HttpTransportOptions } from './http-transport';
import { SseTransport } from './sse-transport';
import { WebSocketTransport } from './websocket-transport';

export class TransportManager {
  readonly native = new NativeTransport();
  readonly http = new HttpTransport();
  readonly sse = new SseTransport();
  readonly websocket = new WebSocketTransport();

  async discover(): Promise<{ native: boolean; http: boolean; transport: 'native' | 'http' | 'mixed' | null }> {
    const native = await this.native.isAvailable();
    const http = await this.http.isAvailable();
    return { native, http, transport: native && http ? 'mixed' : native ? 'native' : http ? 'http' : null };
  }

  requestHttp<T>(route: string, payload: unknown, schema: z.ZodType<T>, token?: string, method?: 'GET' | 'POST', timeoutMs?: number): Promise<T> {
    const options: HttpTransportOptions = { token, method, timeoutMs };
    return this.http.request(route, payload, schema, options);
  }

  requestNative<T>(method: string, payload: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.native.invoke(method, payload, schema);
  }

  closeEvents(): void {
    this.sse.close();
    this.websocket.close();
  }
}
