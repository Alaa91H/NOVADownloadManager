import browser from 'webextension-polyfill';
import { defineContentScript } from 'wxt/utils/define-content-script';
import type { ContentScanResponse } from '../contracts/messages.schema';
import { scanPage } from './scan-page';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    window.addEventListener('error', (event) => {
      console.warn(
        '[NOVA:content] Uncaught error:',
        event.error?.message ?? event.message,
        event.error,
      );
    });
    window.addEventListener('unhandledrejection', (event) => {
      console.warn(
        '[NOVA:content] Unhandled rejection:',
        event.reason?.message ?? event.reason,
      );
    });
    browser.runtime.onMessage.addListener(
      (msg: unknown): Promise<ContentScanResponse> | undefined => {
        if (typeof msg !== 'object' || msg === null) return undefined;
        const type = (msg as { type?: unknown }).type;
        if (type === 'SCAN_PAGE_DOM') {
          return Promise.resolve(
            scanPage(Boolean((msg as { aggressive?: unknown }).aggressive)),
          );
        }
        return undefined;
      },
    );
  },
});
