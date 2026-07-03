import { ErrorCode, ErrorCodeSchema } from '../contracts/errors.schema';

export type ErrorLikeBody = {
  code?: unknown;
  errorCode?: unknown;
  message?: unknown;
  error?: unknown;
  retryable?: unknown;
  repairHint?: unknown;
  details?: unknown;
};

export class AdmExtensionError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly repairHint?: string;
  readonly details?: unknown;

  constructor(input: { code: ErrorCode; message: string; retryable?: boolean; status?: number; repairHint?: string; details?: unknown }) {
    super(input.message);
    this.name = 'AdmExtensionError';
    this.code = input.code;
    this.retryable = input.retryable ?? defaultRetryable(input.code, input.status);
    this.status = input.status;
    this.repairHint = input.repairHint;
    this.details = input.details;
  }
}

export function errorCodeFromStatus(status?: number): ErrorCode {
  if (status === 401) return 'TOKEN_INVALID';
  if (status === 403) return 'BROWSER_INTEGRATION_DISABLED';
  if (status === 404) return 'DAEMON_UNAVAILABLE';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 409) return 'TASK_REJECTED';
  if (status && status >= 500) return 'NETWORK_ERROR';
  return 'UNKNOWN_ERROR';
}

export function defaultRetryable(code: ErrorCode, status?: number): boolean {
  if (code === 'TIMEOUT' || code === 'NETWORK_ERROR' || code === 'DAEMON_UNAVAILABLE' || code === 'ADM_NOT_RUNNING') return true;
  if (code === 'TOKEN_EXPIRED' || code === 'TOKEN_INVALID' || code === 'TOKEN_MISSING') return true;
  if (status && status >= 500) return true;
  return false;
}

export function parseErrorBody(body: unknown, status?: number): { code: ErrorCode; message: string; retryable: boolean; repairHint?: string; details?: unknown } {
  const record = body && typeof body === 'object' ? body as ErrorLikeBody : {};
  const rawCode = typeof record.code === 'string' ? record.code : typeof record.errorCode === 'string' ? record.errorCode : undefined;
  const parsedCode = ErrorCodeSchema.safeParse(rawCode);
  const code = parsedCode.success ? parsedCode.data : errorCodeFromStatus(status);
  const nestedError = record.error;
  const nestedMessage = nestedError && typeof nestedError === 'object' && 'message' in nestedError ? (nestedError as { message?: unknown }).message : undefined;
  const message = typeof record.message === 'string'
    ? record.message
    : typeof nestedMessage === 'string'
      ? nestedMessage
      : status
        ? `HTTP ${status}`
        : 'Extension request failed.';
  const retryable = typeof record.retryable === 'boolean' ? record.retryable : defaultRetryable(code, status);
  const repairHint = typeof record.repairHint === 'string' ? record.repairHint : undefined;
  const details = record.details;
  return { code, message, retryable, repairHint, details };
}

export function toAdmExtensionError(error: unknown, fallbackCode: ErrorCode = 'UNKNOWN_ERROR'): AdmExtensionError {
  if (error instanceof AdmExtensionError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AdmExtensionError({ code: 'TIMEOUT', message: 'Request timed out.', retryable: true });
  }
  if (error instanceof Error) {
    const isNetwork = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up/i.test(error.message);
    const code = isNetwork ? 'NETWORK_ERROR' : fallbackCode;
    return new AdmExtensionError({ code, message: error.message, retryable: defaultRetryable(code) });
  }
  if (typeof error === 'string') {
    return new AdmExtensionError({ code: fallbackCode, message: error, retryable: defaultRetryable(fallbackCode) });
  }
  return new AdmExtensionError({ code: fallbackCode, message: 'Extension request failed.', retryable: defaultRetryable(fallbackCode), details: error });
}

export function isAuthError(error: unknown): boolean {
  const admError = toAdmExtensionError(error);
  return admError.code === 'TOKEN_EXPIRED' || admError.code === 'TOKEN_INVALID' || admError.code === 'TOKEN_MISSING';
}

export function isRetryableHandoffError(error: unknown): boolean {
  return toAdmExtensionError(error).retryable;
}

export function errorMessage(error: unknown): string {
  return toAdmExtensionError(error).message;
}
