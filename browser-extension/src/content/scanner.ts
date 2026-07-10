import browser from 'webextension-polyfill';
import { defineContentScript } from 'wxt/utils/define-content-script';
import type { ContentScanResponse } from '../contracts/messages.schema';
import { installVideoDownloadOverlay } from './overlay-install';
import { scanPage } from './scan-page';
import { CANDIDATE_CACHE_UPDATED_MESSAGE_TYPE, VIDEO_OVERLAY_LIVE_REFRESH_EVENT } from './overlay-types';

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
    installVideoDownloadOverlay();
    browser.runtime.onMessage.addListener(
      (msg: unknown): Promise<ContentScanResponse> | undefined => {
        if (typeof msg !== 'object' || msg === null) return undefined;
        const type = (msg as { type?: unknown }).type;
        if (type === 'SCAN_PAGE_DOM') {
          return Promise.resolve(
            scanPage(Boolean((msg as { aggressive?: unknown }).aggressive)),
          );
        }
        if (type === CANDIDATE_CACHE_UPDATED_MESSAGE_TYPE) {
          window.dispatchEvent(
            new CustomEvent(VIDEO_OVERLAY_LIVE_REFRESH_EVENT, {
              detail: { reason: 'background-candidate-cache' },
            }),
          );
        }
        return undefined;
      },
    );
  },
});
