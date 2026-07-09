import { MAX_RUNTIME_MESSAGE_BYTES } from '../contracts/limits';
import { NovaExtensionError } from '../core/error-classification';
import { byteLength } from '../utils/text';

export function runtimeMessageBytes(value: unknown): number {
  try {
    return byteLength(JSON.stringify(value ?? null));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function assertRuntimeMessageBudget(value: unknown, maxBytes = MAX_RUNTIME_MESSAGE_BYTES): void {
  const sizeBytes = runtimeMessageBytes(value);
  if (!Number.isFinite(sizeBytes) || sizeBytes > maxBytes) {
    throw new NovaExtensionError({
      code: 'VALIDATION_FAILED',
      message: 'Runtime message exceeded the safe extension boundary budget.',
      retryable: false,
      repairHint: 'Reduce imported data size and retry from the extension UI.',
      details: { sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 'unserializable', maxBytes },
    });
  }
}
