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
  /** How long to wait for a freshly woken desktop daemon to bind its port. */
  nativeWakeProbeMs = 4_000;

  async discover(): Promise<{ native: boolean; http: boolean; transport: 'native' | 'http' | 'mixed' | null }> {
    // Fast path first: the loopback HTTP daemon answers in milliseconds when
    // it is running. The native check spawns the desktop executable (1-3s+),
    // so it must never block the common case — it only runs when HTTP is
    // down, where launching the host doubles as a desktop wake-up.
    const httpFirst = await this.http.isAvailable();
    if (httpFirst) {
      return { native: false, http: true, transport: 'http' };
    }

    const native = await this.native.isAvailable();
    if (native) {
      // The native host launch also starts the desktop daemon. Give it a
      // short, adaptive window to bind its port — no fixed multi-second
      // sleep: poll the default port every 250ms until it answers.
      const deadline = Date.now() + this.nativeWakeProbeMs;
      while (Date.now() < deadline) {
        if (await this.http.pingDefault()) {
          // Adopt the daemon URL for subsequent requests.
          await this.http.isAvailable();
          return { native: true, http: true, transport: 'mixed' };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    return { native, http: false, transport: native ? 'native' : null };
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
