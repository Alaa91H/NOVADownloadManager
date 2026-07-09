import browser from 'webextension-polyfill';
import { bridgeManager } from '../bridge/bridge-manager';
import { downloadEntryToCandidate } from '../capture/downloads-capture';
import { RuleEngine } from '../rules/rule-engine';
import { CandidateCache } from '../storage/candidate-cache';
import { SettingsStore } from '../storage/settings-store';
import { SiteRulesStore } from '../storage/site-rules-store';
import { MetadataEnricher } from '../pipeline/metadata-enricher';
import { OutboxStore } from '../outbox/outbox-store';
import { catchAndIgnore } from '../core/safe-catch';
import { installDnrRules, removeDnrRules } from './dnr-rules';

const STORAGE_KEY = 'nova-download-state';
const CANCEL_RETRIES = 3;
const CANCEL_DELAY = 150;

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
  } catch {
    try {
      const arr = Array.from(map.values()).slice(-20);
      await browser.storage.local.set({ [STORAGE_KEY]: arr });
    } catch {
      // give up
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

export async function registerDownloadInterceptor(): Promise<void> {
  if (interceptorReady) return;
  const settings = await new SettingsStore().get().catch(() => null);
  if (!settings || !settings.enabled) return;
  if (!settings.capture.downloads && !settings.capture.aggressiveMode) return;

  if (browser.downloads?.onCreated) {
    browser.downloads.onCreated.addListener((item) => {
      catchAndIgnore(handleDownload(item), 'download-interceptor');
    });
  }

  if (browser.downloads?.onChanged) {
    browser.downloads.onChanged.addListener((delta) => {
      catchAndIgnore(handleChange(delta), 'download-interceptor:change');
    });
  }

  await installDnrRules();
  interceptorReady = true;
}

export async function unregisterDownloadInterceptor(): Promise<void> {
  await removeDnrRules();
  interceptorReady = false;
}

export async function handleDownload(item: ChromeDownloadItem): Promise<void> {
  if (!item.url) return;
  if (typeof item.id !== 'number') return;
  if (pendingDownloads.has(item.id)) return;

  pendingDownloads.add(item.id);
  try {
    const settings = await new SettingsStore().get().catch(() => null);
    if (!settings?.enabled) return;

    const shouldOverride = shouldTakeover(item, settings);
    if (!shouldOverride) return;

    const state = await loadState();
    if (state.has(item.id)) return;

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

    // Cancel browser download IMMEDIATELY (before enriching metadata)
    const cancelled = await cancelDownload(item.id);

    // Then enrich and send to NOVA in parallel
    const raw = downloadEntryToCandidate({
      url: item.url,
      finalUrl: item.finalUrl,
      filename: cancelled ? item.filename : undefined,
      mime: item.mime,
      fileSize: item.fileSize,
      totalBytes: item.totalBytes,
      referrer: item.referrer,
      tabId: item.tabId,
    }, new Date().toISOString());
    const candidate = new MetadataEnricher().enrich(raw);

    const tabId = typeof item.tabId === 'number' && item.tabId >= 0 ? item.tabId : undefined;
    if (tabId !== undefined) {
      await new CandidateCache().merge(tabId, [candidate]).catch(() => {});
    }

    try {
      await bridgeManager.sendCandidate(candidate);
    } catch {
      if (!cancelled) {
        // NOVA unreachable and download not cancelled — let browser keep it
        pendingDownloads.delete(item.id);
        return;
      }
    }

    // Clean up from download bar
    await browser.downloads.erase({ id: item.id }).catch(() => {});

    pendingDownloads.delete(item.id);
  } catch {
    pendingDownloads.delete(item.id);
  }
}

async function handleChange(delta: browser.Downloads.OnChangedDownloadDeltaType): Promise<void> {
  if (!delta.state?.current) return;
  if (delta.state.current !== 'in_progress' && delta.state.current !== 'active') return;
  if (typeof delta.id !== 'number') return;
  if (pendingDownloads.has(delta.id)) return;

  pendingDownloads.add(delta.id);
  try {
    const items = await browser.downloads.search({ id: delta.id }).catch(() => []);
    if (!items?.[0]?.url) return;
    const item = items[0] as ChromeDownloadItem;

    const settings = await new SettingsStore().get().catch(() => null);
    if (!settings?.enabled) return;
    if (!shouldTakeover(item, settings)) return;

    // Cancel the download that's in progress
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
    } catch {
      // NOVA unreachable
    }

    await browser.downloads.erase({ id: delta.id }).catch(() => {});
    pendingDownloads.delete(delta.id);
  } catch {
    pendingDownloads.delete(delta.id);
  }
}

function shouldTakeover(
  item: ChromeDownloadItem,
  settings: Awaited<ReturnType<SettingsStore['get']>>,
): boolean {
  const capture = settings.capture;
  if (!capture.takeoverEnabled) return false;

  const url = item.finalUrl ?? item.url ?? '';
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (capture.neverTakeoverHosts.some((h: string) => host.endsWith(h))) return false;
    if (capture.alwaysTakeoverHosts.some((h: string) => host.endsWith(h))) return true;
  } catch { /* malformed URL */ }

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
    // NOVA not available — candidate will be retried by content script or user
  }
}
