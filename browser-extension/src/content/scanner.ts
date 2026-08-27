import browser from 'webextension-polyfill';
import { defineContentScript } from 'wxt/utils/define-content-script';
import type { ContentScanResponse } from '../contracts/messages.schema';
import { scanPage } from './scan-page';
import { shouldSuppressContentScriptWindowError } from './extension-context';

export default defineContentScript({
  matches: ['<all_urls>'],
  main(ctx) {
    ctx.addEventListener(window, 'error', (event) => {
      if (shouldSuppressContentScriptWindowError(event.message, event.error)) return;
      console.warn(
        '[NOVA:content] Uncaught error:',
        event.error?.message ?? event.message,
        event.error,
      );
    });
    ctx.addEventListener(window, 'unhandledrejection', (event) => {
      if (shouldSuppressContentScriptWindowError('', event.reason)) return;
      console.warn(
        '[NOVA:content] Unhandled rejection:',
        event.reason?.message ?? event.reason,
      );
    });
    const onRuntimeMessage = (msg: unknown): Promise<ContentScanResponse> | undefined => {
      if (ctx.isInvalid || typeof msg !== 'object' || msg === null) return undefined;
      const type = (msg as { type?: unknown }).type;
      if (type === 'SCAN_PAGE_DOM') {
        return Promise.resolve(
          scanPage(Boolean((msg as { aggressive?: unknown }).aggressive)),
        );
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(onRuntimeMessage);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(onRuntimeMessage));
  },
});
