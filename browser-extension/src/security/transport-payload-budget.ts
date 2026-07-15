import { MAX_HTTP_REQUEST_PAYLOAD_BYTES, MAX_HTTP_RESPONSE_BYTES, MAX_NATIVE_MESSAGE_BYTES } from '../contracts/limits';
import { byteLength } from '../utils/text';
import { NovaExtensionError } from '../core/error-classification';

function budgetExceeded(message: string, details: Record<string, unknown>): never {
  throw new NovaExtensionError({ code: 'VALIDATION_FAILED', message, retryable: false, details });
}

export function encodeJsonPayloadWithBudget(payload: unknown, maxBytes = MAX_HTTP_REQUEST_PAYLOAD_BYTES): string {
  const json = JSON.stringify(payload ?? {});
  const sizeBytes = byteLength(json);
  if (sizeBytes > maxBytes) {
    budgetExceeded('HTTP request payload exceeded the safe transport budget.', { sizeBytes, maxBytes });
  }
  return json;
}

export async function readJsonResponseWithBudget(response: Response, maxBytes = MAX_HTTP_RESPONSE_BYTES): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number.isFinite(Number(contentLength)) && Number(contentLength) > maxBytes) {
    budgetExceeded('HTTP response advertised a body larger than the safe transport budget.', { contentLength: Number(contentLength), maxBytes });
  }

  const text = await readResponseTextWithBudget(response, maxBytes);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, message: `HTTP ${response.status}: invalid JSON response` };
  }
}

export async function readResponseTextWithBudget(response: Response, maxBytes = MAX_HTTP_RESPONSE_BYTES): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    const sizeBytes = byteLength(text);
    if (sizeBytes > maxBytes) budgetExceeded('HTTP response exceeded the safe transport budget.', { sizeBytes, maxBytes });
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      budgetExceeded('HTTP response exceeded the safe transport budget.', { sizeBytes: totalBytes, maxBytes });
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function assertNativeMessageBudget(message: unknown, direction: 'request' | 'response', maxBytes = MAX_NATIVE_MESSAGE_BYTES): void {
  const json = JSON.stringify(message ?? null);
  const sizeBytes = byteLength(json);
  if (sizeBytes > maxBytes) {
    budgetExceeded(`Native Messaging ${direction} exceeded the safe transport budget.`, { sizeBytes, maxBytes, direction });
  }
}
