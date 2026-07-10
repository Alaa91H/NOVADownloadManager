import browser from 'webextension-polyfill';
import { AGGRESSIVE_MAX_SCAN_REQUESTS_PER_TAB_PER_MINUTE, MAX_SCAN_REQUESTS_PER_TAB_PER_MINUTE } from '../contracts/limits';
import { NovaExtensionError } from '../core/error-classification';
import type { ScanBudgetProfile } from './scan-result-budget';

export type RuntimeMessageSenderLike = {
  url?: string;
  tab?: { id?: number };
};

const SCAN_WINDOW_MS = 60_000;
const scanTimestampsByTab = new Map<number, number[]>();

const TRUSTED_EXTENSION_UI_SURFACE_NAMES = ['popup', 'options', 'diagnostics'];
// Exact trusted UI paths: '/popup.html', '/options.html', '/diagnostics.html'.
const TRUSTED_EXTENSION_UI_PATHS = new Set(TRUSTED_EXTENSION_UI_SURFACE_NAMES.map((surface) => `/${surface}.html`));

export function isExtensionUiSender(sender: RuntimeMessageSenderLike | undefined): boolean {
  const senderUrl = sender?.url;
  if (!senderUrl) return false;
  const extensionRoot = browser.runtime.getURL('');
  if (!senderUrl.startsWith(extensionRoot)) return false;
  try {
    const pathname = new URL(senderUrl).pathname.toLowerCase().replace(/\/+$/, '');
    return TRUSTED_EXTENSION_UI_PATHS.has(pathname);
  } catch {
    return false;
  }
}

export function assertUserActivatedScan(sender: RuntimeMessageSenderLike | undefined, userActivated: boolean): void {
  if (!userActivated) {
    throw new NovaExtensionError({
      code: 'PERMISSION_MISSING',
      message: 'Page scanning requires an explicit user action.',
      retryable: false,
      repairHint: 'Open the popup or use the context menu and trigger Scan page manually.',
    });
  }
  if (!isExtensionUiSender(sender)) {
    throw new NovaExtensionError({
      code: 'PERMISSION_MISSING',
      message: 'User-activated page scanning is only accepted from extension UI surfaces.',
      retryable: false,
      repairHint: 'Use the extension popup, options page, diagnostics page, context menu, or keyboard command.',
    });
  }
}

// Overlay scan is the only scan path accepted from an in-page content script.
// It must originate from a real tab; the resolved tab id is then used to bind
// the scan, so the page cannot target any other tab.
export function assertOverlayScanSender(sender: RuntimeMessageSenderLike | undefined): number {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0) {
    throw new NovaExtensionError({
      code: 'PERMISSION_MISSING',
      message: 'Overlay scan requires an originating tab.',
      retryable: false,
      repairHint: 'Trigger the scan from the in-page NOVA overlay button.',
    });
  }
  return tabId;
}

export function assertScanRateLimit(tabId: number, now = Date.now(), profile: ScanBudgetProfile = 'standard'): void {
  const limit = profile === 'aggressive' ? AGGRESSIVE_MAX_SCAN_REQUESTS_PER_TAB_PER_MINUTE : MAX_SCAN_REQUESTS_PER_TAB_PER_MINUTE;
  const recent = (scanTimestampsByTab.get(tabId) ?? []).filter((timestamp) => now - timestamp < SCAN_WINDOW_MS);
  if (recent.length >= limit) {
    scanTimestampsByTab.set(tabId, recent);
    throw new NovaExtensionError({
      code: 'PERMISSION_MISSING',
      message: 'Page scan rate limit reached for this tab.',
      retryable: true,
      repairHint: 'Wait a few seconds before scanning the same tab again.',
    });
  }
  scanTimestampsByTab.set(tabId, [...recent, now]);
}
