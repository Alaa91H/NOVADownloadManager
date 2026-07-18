import { Logger } from './logger';

const log = new Logger('safe-catch');

/**
 * Awaits a promise and returns `undefined` on rejection (error is logged).
 * Use when the caller can tolerate a silent skip.
 */
export function catchAndLog<T>(promise: Promise<T>, context: string): Promise<T | undefined> {
  return promise.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Caught in "${context}": ${message}`, error);
    return undefined as T | undefined;
  });
}

/**
 * Fire-and-forget with error logging. The returned promise is intentionally
 * not awaited; any rejection is caught and logged.
 */
export function catchAndIgnore<T>(promise: Promise<T>, context: string): void {
  promise.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Caught and ignored in "${context}": ${message}`, error);
  });
}
