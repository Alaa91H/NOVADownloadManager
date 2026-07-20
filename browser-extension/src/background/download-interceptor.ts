import browser from 'webextension-polyfill';
import { bridgeManager } from '../bridge/bridge-manager';
import { downloadEntryToCandidate } from '../capture/downloads-capture';
import { CandidateCache } from '../storage/candidate-cache';
import { SettingsStore } from '../storage/settings-store';
import { MetadataEnricher } from '../pipeline/metadata-enricher';
import { catchAndIgnore } from '../core/safe-catch';
import { installDnrRules, removeDnrRules } from './dnr-rules';

const STORAGE_KEY = 'nova-download-state';
const CANCEL_RETRIES = 5;
const CANCEL_DELAY = 50;

type ChromeDownloadItem = browser.Downloads.DownloadItem & {
  finalUrl?: string;
  tabId?: number;
};

interface DownloadState {
  id: number;
  url: string;
  finalUrl?: string;
  filename?: string;
  mime?: string;
  fileSize?: number;
  totalBytes?: number;
  referrer?: string;
  tabId?: number;
  handoffAttempted: boolean;
  capturedAt: string;
}

let interceptorReady = false;
let pendingDownloads = new Set<number>();

async function loadState(): Promise<Map<number, DownloadState>> {
  try {
    const r = await browser.storage.local.get(STORAGE_KEY);
    const raw = r[STORAGE_KEY] as DownloadState[] | undefined;
    const arr: DownloadState[] = raw || [];
    return new Map(arr.map((d) => [d.id, d]));
  } catch {
    return new Map();
  }
}

async function saveState(map: Map<number, DownloadState>): Promise<void> {
  try {
    const arr = Array.from(map.values()).slice(-100);
    await browser.storage.local.set({ [STORAGE_KEY]: arr });
  } catch (e) {
    console.warn('download-interceptor: saveState failed, retrying with smaller payload', e);
    try {
      const arr = Array.from(map.values()).slice(-20);
      await browser.storage.local.set({ [STORAGE_KEY]: arr });
    } catch (e2) {
      console.error('download-interceptor: saveState failed after retry', e2);
    }
  }
}

async function cancelDownload(downloadId: number): Promise<boolean> {
  for (let i = 0; i < CANCEL_RETRIES; i++) {
    try {
      await browser.downloads.cancel(downloadId);
      await browser.downloads.erase({ id: downloadId }).catch(() => {});
      return true;
    } catch {
      if (i < CANCEL_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, CANCEL_DELAY * (i + 1)));
      }
    }
  }
  return false;
}

/**
 * Ensure the desktop bridge is ready, but never block download takeover on it.
 * Candidates are always enqueued to the outbox first; this only flushes them.
 */
async function ensureBridgeForHandoff(): Promise<void> {
  try {
    if (bridgeManager.getState().canSend) return;
    const connected = await bridgeManager.autoConnect().catch(() => null);
    if (connected?.canSend) return;
    await bridgeManager.wakeUpDesktop().catch(() => null);
  } catch {
    // Offline is fine — outbox retries later.
  }
}

/**
 * Register the download takeover listeners.
 *
 * MUST be called synchronously from the background entrypoint's first turn:
 * in Manifest V3 the service worker is suspended between events, and an event
 * that wakes it is only delivered to listeners that were registered
 * synchronously during startup. Any `await` (settings, storage) before
 * `addListener` silently loses the very download that woke the worker — which
 * presents as "the extension never captures anything". All gating
 * (settings, takeover rules, bridge readiness) therefore lives inside the
 * handlers, never in front of the registration.
 */
export function registerDownloadInterceptor(): void {
  if (interceptorReady) return;
  interceptorReady = true;

  if (browser.downloads?.onCreated?.addListener) {
    browser.downloads.onCreated.addListener((item) => {
      catchAndIgnore(handleDownload(item), 'download-interceptor');
    });
  }

  if (browser.downloads?.onChanged?.addListener) {
    browser.downloads.onChanged.addListener((delta) => {
      catchAndIgnore(handleChange(delta), 'download-interceptor:change');
    });
  }

  // DNR rules are additive hardening; install them without blocking listener
  // registration.
  void installDnrRules().catch(() => {});
}

export async function unregisterDownloadInterceptor(): Promise<void> {
  // Listeners stay registered (their handlers gate on settings); only the DNR
  // hardening rules are withdrawn. Never reset the latch — re-registering
  // would stack duplicate listeners.
  await removeDnrRules();
}

export async function handleDownload(item: ChromeDownloadItem): Promise<void> {
  if (!item.url) return;
  if (typeof item.id !== 'number') return;
  if (pendingDownloads.has(item.id)) return;

  pendingDownloads.add(item.id);
  try {
    const settings = await new SettingsStore().get().catch(() => null);
    if (!settings?.enabled) {
      pendingDownloads.delete(item.id);
      return;
    }
    if (!settings.capture.downloads && !settings.capture.aggressiveMode) {
      pendingDownloads.delete(item.id);
      return;
    }

    const shouldOverride = shouldTakeover(item, settings);
    if (!shouldOverride) {
      pendingDownloads.delete(item.id);
      return;
    }

    const state = await loadState();
    if (state.has(item.id)) {
      pendingDownloads.delete(item.id);
      return;
    }

    state.set(item.id, {
      id: item.id,
      url: item.url,
      finalUrl: item.finalUrl,
      filename: item.filename,
      mime: item.mime,
      fileSize: item.fileSize,
      totalBytes: item.totalBytes,
      referrer: item.referrer,
      tabId: item.tabId,
      handoffAttempted: true,
      capturedAt: new Date().toISOString(),
    });
    await saveState(state);

    // Absolute takeover: cancel the browser download FIRST, before any bridge
    // round-trip. Candidates always land in the outbox and flush when NOVA is up.
    const cancelled = await cancelDownload(item.id);

    const raw = downloadEntryToCandidate({
      url: item.url,
      finalUrl: item.finalUrl,
      filename: item.filename,
      mime: item.mime,
      fileSize: item.fileSize,
      totalBytes: item.totalBytes,
      referrer: item.referrer,
      tabId: item.tabId,
    }, new Date().toISOString());
    const candidate = new MetadataEnricher().enrich(raw);

    const tabId = typeof item.tabId === 'number' && item.tabId >= 0 ? item.tabId : undefined;
    if (tabId !== undefined) {
      await new CandidateCache().merge(tabId, [candidate]).catch((e) => {
        console.warn('download-interceptor: CandidateCache.merge failed', e);
      });
    }

    // Enqueue for NOVA (outbox) then try to flush via bridge.
    try {
      await bridgeManager.sendCandidate(candidate);
    } catch (e) {
      console.warn('download-interceptor: bridgeManager.sendCandidate failed', e);
    }

    void ensureBridgeForHandoff();

    if (cancelled) {
      await browser.downloads.erase({ id: item.id }).catch((e) => {
        console.warn('download-interceptor: downloads.erase failed', e);
      });
    }

    pendingDownloads.delete(item.id);
  } catch {
    pendingDownloads.delete(item.id);
  }
}

async function handleChange(delta: browser.Downloads.OnChangedDownloadDeltaType): Promise<void> {
  if (typeof delta.id !== 'number') return;
  if (pendingDownloads.has(delta.id)) return;

  // Catch late-arriving or slow downloads that onCreated missed, plus any
  // in-progress item still held by the browser.
  const stateHint = delta.state?.current;
  if (stateHint === 'complete' || stateHint === 'interrupted') return;

  pendingDownloads.add(delta.id);
  try {
    const existingState = await loadState();
    if (existingState.has(delta.id)) {
      pendingDownloads.delete(delta.id);
      return;
    }

    const items = await browser.downloads.search({ id: delta.id }).catch(() => []);
    if (!items?.[0]?.url) {
      pendingDownloads.delete(delta.id);
      return;
    }
    const item = items[0] as ChromeDownloadItem;

    const settings = await new SettingsStore().get().catch(() => null);
    if (!settings?.enabled) {
      pendingDownloads.delete(delta.id);
      return;
    }
    if (!settings.capture.downloads && !settings.capture.aggressiveMode) {
      pendingDownloads.delete(delta.id);
      return;
    }
    if (!shouldTakeover(item, settings)) {
      pendingDownloads.delete(delta.id);
      return;
    }

    const cancelled = await cancelDownload(delta.id);
    if (!cancelled) {
      pendingDownloads.delete(delta.id);
      return;
    }

    const raw = downloadEntryToCandidate({
      url: item.url,
      finalUrl: item.finalUrl,
      filename: item.filename,
      mime: item.mime,
      fileSize: item.fileSize,
      totalBytes: item.totalBytes,
      referrer: item.referrer,
      tabId: item.tabId,
    }, new Date().toISOString());
    const candidate = new MetadataEnricher().enrich(raw);

    try {
      await bridgeManager.sendCandidate(candidate);
    } catch (e) {
      console.warn('download-interceptor: bridgeManager.sendCandidate failed in handleChange', e);
    }

    void ensureBridgeForHandoff();

    await browser.downloads.erase({ id: delta.id }).catch((e) => {
      console.warn('download-interceptor: downloads.erase failed in handleChange', e);
    });
    pendingDownloads.delete(delta.id);
  } catch {
    pendingDownloads.delete(delta.id);
  }
}

/**
 * Absolute takeover policy:
 * - aggressiveMode OR takeoverEnabled => claim the download
 * - neverTakeoverHosts is the only host allow-list escape
 * - alwaysTakeoverHosts forces claim even when filters would skip
 * - size / file-type filters only apply when NOT in aggressive mode
 */
export function shouldTakeover(
  item: ChromeDownloadItem,
  settings: Awaited<ReturnType<SettingsStore['get']>>,
): boolean {
  const capture = settings.capture;
  if (!capture.takeoverEnabled && !capture.aggressiveMode) return false;

  const url = item.finalUrl ?? item.url ?? '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return false;
    // Match either an exact host or a proper subdomain (".example.com" matches
    // "a.example.com" but NOT "notexample.com"). The previous `host.endsWith(h)`
    // check produced false positives for unrelated hosts sharing a suffix.
    const hostMatches = (list: string[]): boolean =>
      list.some((h: string) => {
        const lower = h.toLowerCase();
        return host === lower || host.endsWith(`.${lower}`);
      });
    if (hostMatches(capture.neverTakeoverHosts)) {
      if (!hostMatches(capture.alwaysTakeoverHosts)) {
        return false;
      }
    }
    if (hostMatches(capture.alwaysTakeoverHosts)) {
      return true;
    }
  } catch {
    /* malformed URL — still attempt takeover */
  }

  // Absolute aggressive path: claim every remaining download.
  if (capture.aggressiveMode) return true;

  const sizeBytes = item.totalBytes ?? item.fileSize ?? 0;
  if (sizeBytes > 0 && sizeBytes < capture.takeoverMinSizeMB * 1024 * 1024) return false;

  if (capture.takeoverFileTypes.length > 0) {
    const ext = (item.filename ?? url).split('.').pop()?.toLowerCase() ?? '';
    return capture.takeoverFileTypes.includes(ext);
  }

  return true;
}

export async function handleManualCapture(payload: {
  url: string;
  filename?: string;
  referrer?: string;
  source: string;
}): Promise<void> {
  if (!payload.url) return;
  const settings = await new SettingsStore().get().catch(() => null);
  if (!settings?.enabled) return;

  const raw = downloadEntryToCandidate({
    url: payload.url,
    filename: payload.filename,
    referrer: payload.referrer,
    fileSize: 0,
    totalBytes: 0,
  }, new Date().toISOString());
  const candidate = new MetadataEnricher().enrich(raw);
  try {
    await bridgeManager.sendCandidate(candidate);
  } catch {
    // NOVA not available — candidate stays in outbox for retry
  }
  void ensureBridgeForHandoff();
}
