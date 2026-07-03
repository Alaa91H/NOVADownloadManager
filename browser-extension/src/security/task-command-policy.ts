import { MAX_TASK_ID_CHARS } from '../contracts/limits';
import { AdmExtensionError } from '../core/error-classification';

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function assertTaskIdSafe(taskId: string): string {
  const trimmed = taskId.trim();
  if (!trimmed) {
    throw new AdmExtensionError({ code: 'VALIDATION_FAILED', message: 'Task id is required.', retryable: false });
  }
  if (trimmed.length > MAX_TASK_ID_CHARS) {
    throw new AdmExtensionError({
      code: 'VALIDATION_FAILED',
      message: `Task id exceeds the safe ${MAX_TASK_ID_CHARS} character limit.`,
      retryable: false,
    });
  }
  if (hasControlCharacter(trimmed)) {
    throw new AdmExtensionError({
      code: 'VALIDATION_FAILED',
      message: 'Task id contains control characters.',
      retryable: false,
    });
  }
  return trimmed;
}
