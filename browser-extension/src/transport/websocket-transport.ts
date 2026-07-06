import { AdmEvent, AdmEventSchema } from '../contracts/events.schema';
import { MAX_EVENT_MESSAGE_BYTES } from '../contracts/limits';
import { AdmExtensionError } from '../core/error-classification';
import { byteLength } from '../utils/text';
import { assertAdmLoopbackWsUrl } from './loopback-url-policy';

export type WebSocketHandlers = {
  onEvent(event: AdmEvent): void;
  onError(error: unknown): void;
  onClose?(): void;
};

export class WebSocketTransport {
  private ws?: WebSocket;

  connect(url: string, handlers: WebSocketHandlers, timeoutMs = 10_000): void {
    this.close();
    const safeUrl = assertAdmLoopbackWsUrl(url);
    const ws = new WebSocket(safeUrl);
    this.ws = ws;
    const timeout = setTimeout(() => {
      ws.close();
      handlers.onError(new AdmExtensionError({ code: 'TIMEOUT', message: 'WebSocket connection timed out.', retryable: true }));
    }, timeoutMs);
    ws.onopen = () => clearTimeout(timeout);
    ws.onmessage = (event) => {
      try {
        const data = String(event.data);
        if (byteLength(data) > MAX_EVENT_MESSAGE_BYTES) {
          handlers.onError(new AdmExtensionError({ code: 'VALIDATION_FAILED', message: 'WebSocket event exceeded the safe event budget.', retryable: true }));
          return;
        }
        const parsed = AdmEventSchema.safeParse(JSON.parse(data));
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
