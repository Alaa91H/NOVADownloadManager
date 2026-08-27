const CONTEXT_INVALIDATED_MESSAGE = 'extension context invalidated';
const RESIZE_OBSERVER_LOOP_MESSAGE = 'resizeobserver loop completed with undelivered notifications';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/**
 * An old content script remains alive briefly when its extension is updated or
 * reloaded. Calls into the old runtime are no longer valid and must terminate
 * local best-effort work rather than surface an uncaught rejection to a page.
 */
export function isExtensionContextInvalidated(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes(CONTEXT_INVALIDATED_MESSAGE);
}

/**
 * Browsers emit this exact error when they defer a cyclic ResizeObserver
 * notification. NOVA owns no ResizeObserver in its content scripts, so this is
 * only suppressed at the diagnostic boundary; other window errors remain visible.
 */
export function shouldSuppressContentScriptWindowError(message: string, error: unknown): boolean {
  const normalizedMessage = `${message} ${errorMessage(error)}`.toLowerCase();
  return (
    normalizedMessage.includes(CONTEXT_INVALIDATED_MESSAGE)
    || normalizedMessage.includes(RESIZE_OBSERVER_LOOP_MESSAGE)
  );
}
