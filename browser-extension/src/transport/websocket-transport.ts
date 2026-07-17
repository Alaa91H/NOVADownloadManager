import { NovaEvent, NovaEventSchema } from '../contracts/events.schema';
import { MAX_EVENT_MESSAGE_BYTES } from '../contracts/limits';
import { NovaExtensionError } from '../core/error-classification';
import { byteLength } from '../utils/text';
import { assertNovaLoopbackWsUrl } from './loopback-url-policy';

export type WebSocketHandlers = {
  onEvent(event: NovaEvent): void;
  onError(error: unknown): void;
  onClose?(): void;
};

export class WebSocketTransport {
  private ws?: WebSocket;

  connect(url: string, handlers: WebSocketHandlers, timeoutMs = 10_000): void {
    this.close();
    const safeUrl = assertNovaLoopbackWsUrl(url);
    const ws = new WebSocket(safeUrl);
    this.ws = ws;
    const timeout = setTimeout(() => {
      ws.close();
      handlers.onError(new NovaExtensionError({ code: 'TIMEOUT', message: 'WebSocket connection timed out.', retryable: true }));
    }, timeoutMs);
    ws.onopen = () => clearTimeout(timeout);
    ws.onmessage = (event) => {
      try {
        const data = String(event.data);
        if (byteLength(data) > MAX_EVENT_MESSAGE_BYTES) {
          handlers.onError(new NovaExtensionError({ code: 'VALIDATION_FAILED', message: 'WebSocket event exceeded the safe event budget.', retryable: true }));
          return;
        }
        const parsed = NovaEventSchema.safeParse(JSON.parse(data));
        if (parsed.success) handlers.onEvent(parsed.data);
      } catch (error) {
        handlers.onError(error);
      }
    };
    ws.onerror = (event) => handlers.onError(event);
    ws.onclose = () => {
      clearTimeout(timeout);
      handlers.onClose?.();
    };
  }

  close(): void {
    this.ws?.close();
    this.ws = undefined;
  }
}
