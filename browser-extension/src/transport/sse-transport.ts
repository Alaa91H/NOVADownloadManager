import { NovaEvent, NovaEventSchema } from '../contracts/events.schema';
import { MAX_EVENT_MESSAGE_BYTES, MAX_EVENT_PARSE_ERRORS_PER_CONNECTION, MAX_SSE_BUFFER_BYTES } from '../contracts/limits';
import { NovaExtensionError } from '../core/error-classification';
import { byteLength } from '../utils/text';
import { assertNovaLoopbackHttpUrl } from './loopback-url-policy';

export type SseHandlers = {
  onEvent(event: NovaEvent): void;
  onError(error: unknown): void;
  onOpen?(): void;
};

export class SseTransport {
  private abort?: AbortController;

  async connectFirst(urls: string[], token: string, handlers: SseHandlers): Promise<void> {
    let lastError: unknown;
    for (const url of urls) {
      try {
        await this.connect(url, token, handlers);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    handlers.onError(lastError ?? new Error('SSE connection failed'));
  }

  async connect(url: string, token: string, handlers: SseHandlers): Promise<void> {
    this.close();
    const safeUrl = assertNovaLoopbackHttpUrl(url);
    const controller = new AbortController();
    this.abort = controller;
    const response = await fetch(safeUrl, { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
    handlers.onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let parseErrors = 0;
    try {
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (!controller.signal.aborted) handlers.onError(new Error('SSE stream closed.'));
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        if (byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
          throw new NovaExtensionError({ code: 'VALIDATION_FAILED', message: 'SSE buffer exceeded the safe event budget.', retryable: true });
        }
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const rawEvent of events) {
          const data = rawEvent.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (!data) continue;
          if (byteLength(data) > MAX_EVENT_MESSAGE_BYTES) {
            parseErrors += 1;
            continue;
          }
          const parsedJson = safeJson(data);
          const parsed = NovaEventSchema.safeParse(parsedJson);
          if (parsed.success) {
            handlers.onEvent(parsed.data);
            continue;
          }
          parseErrors += 1;
          if (parseErrors > MAX_EVENT_PARSE_ERRORS_PER_CONNECTION) {
            throw new NovaExtensionError({ code: 'VALIDATION_FAILED', message: 'SSE event stream produced too many invalid events.', retryable: true });
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) handlers.onError(error);
    }
  }

  close(): void {
    this.abort?.abort();
    this.abort = undefined;
  }
}

function safeJson(input: string): unknown {
  try { return JSON.parse(input); } catch { return undefined; }
}
