import browser from 'webextension-polyfill';
import { isExtensionContextInvalidated } from './extension-context-diagnostics';

export {
  isExtensionContextInvalidated,
  shouldSuppressContentScriptWindowError,
} from './extension-context-diagnostics';

export function hasActiveExtensionContext(): boolean {
  try {
    return Boolean(browser.runtime?.id);
  } catch {
    return false;
  }
}

/**
 * Send a one-shot runtime message only while the current extension context is
 * valid. `undefined` means the context was invalidated and callers must stop
 * their stale work quietly; other errors are preserved for normal diagnostics.
 */
export async function sendRuntimeMessageIfActive<T>(message: unknown): Promise<T | undefined> {
  if (!hasActiveExtensionContext()) return undefined;
  try {
    return (await browser.runtime.sendMessage(message)) as T;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) return undefined;
    throw error;
  }
}
