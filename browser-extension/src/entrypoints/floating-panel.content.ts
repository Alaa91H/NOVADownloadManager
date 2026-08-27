import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main(ctx) {
    void import('../content/floating-panel')
      .then(({ initFloatingPanel }) => {
        if (!ctx.isInvalid) initFloatingPanel(ctx);
      })
      .catch(() => {
        // Content UI is optional; do not turn a stale/replaced script into a page error.
      });
  },
});
