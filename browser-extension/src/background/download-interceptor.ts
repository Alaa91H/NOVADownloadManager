import browser from 'webextension-polyfill';
import { bridgeManager } from '../bridge/bridge-manager';
import { downloadEntryToCandidate } from '../capture/downloads-capture';
import { RuleEngine } from '../rules/rule-engine';
import { CandidateCache } from '../storage/candidate-cache';
import { SettingsStore } from '../storage/settings-store';
import { SiteRulesStore } from '../storage/site-rules-store';
import { MetadataEnricher } from '../pipeline/metadata-enricher';
import { OutboxStore } from '../outbox/outbox-store';
import { catchAndLog, catchAndIgnore } from '../core/safe-catch';

type DownloadItemLike = {
  id?: number;
  url?: string;
  finalUrl?: string;
  filename?: string;
  mime?: string;
  fileSize?: number;
  totalBytes?: number;
  referrer?: string;
  tabId?: number;
};

type DownloadDeltaLike = {
  id: number;
  url?: { current?: string };
  finalUrl?: { current?: string };
  filename?: { current?: string };
  mime?: { current?: string };
  fileSize?: { current?: number };
  totalBytes?: { current?: number };
  state?: { current?: string };
};

// Idempotency: track which download ids have already triggered a handoff attempt
const handoffAttempted = new Set<number>();
const knownDownloads = new Map<number, DownloadItemLike>();
let downloadInterceptorRegistered = false;

export function registerDownloadInterceptor(): void {
  if (downloadInterceptorRegistered) return;
  const downloadsApi = browser.downloads;
  if (!downloadsApi?.onCreated) return;
  downloadsApi.onCreated.addListener((item: DownloadItemLike) => {
    catchAndIgnore(handleDownloadCreated(item), 'download-interceptor:created');
  });
  downloadsApi.onChanged?.addListener((delta: DownloadDeltaLike) => {
    catchAndIgnore(handleDownloadChanged(delta), 'download-interceptor:changed');
  });
  downloadInterceptorRegistered = true;
}

async function handleDownloadCreated(item: DownloadItemLike): Promise<void> {
  if (typeof item.id === 'number') knownDownloads.set(item.id, item);
  await captureDownload(item);
}

async function handleDownloadChanged(delta: DownloadDeltaLike): Promise<void> {
  const current = knownDownloads.get(delta.id) ?? { id: delta.id };
  const next: DownloadItemLike = {
    ...current,
    url: delta.url?.current ?? current.url,
    finalUrl: delta.finalUrl?.current ?? current.finalUrl,
    filename: delta.filename?.current ?? current.filename,
    mime: delta.mime?.current ?? current.mime,
    fileSize: delta.fileSize?.current ?? current.fileSize,
    totalBytes: delta.totalBytes?.current ?? current.totalBytes,
  };
  knownDownloads.set(delta.id, next);
  await captureDownload(next);
}

function shouldTakeover(
  item: DownloadItemLike,
  settings: Awaited<ReturnType<SettingsStore['get']>>,
): boolean {
  const capture = settings.capture;
  if (!capture.takeoverEnabled) return false;

  const url = item.finalUrl ?? item.url ?? '';
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (capture.neverTakeoverHosts.some((h) => host.endsWith(h))) return false;
    if (capture.alwaysTakeoverHosts.some((h) => host.endsWith(h))) return true;
  } catch { /* malformed URL: fall through */ }

  const sizeBytes = item.totalBytes ?? item.fileSize ?? 0;
  if (sizeBytes > 0 && sizeBytes < capture.takeoverMinSizeMB * 1024 * 1024) return false;

  if (capture.takeoverFileTypes.length > 0) {
    const ext = (item.filename ?? url).split('.').pop()?.toLowerCase() ?? '';
    return capture.takeoverFileTypes.includes(ext);
  }

  return true;
}

async function captureDownload(item: DownloadItemLike): Promise<void> {
  if (!item.url) return;
  const settings = await new SettingsStore().get();
  if (!settings.enabled || (!settings.capture.downloads && !settings.capture.aggressiveMode)) return;

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
  if (tabId !== undefined) await new CandidateCache().merge(tabId, [candidate]);

  const rules = await new SiteRulesStore().list();
  const engine = new RuleEngine(rules);

  // --- Downloads takeover (Phase 5) ---
  if (typeof item.id === 'number' && !handoffAttempted.has(item.id) && shouldTakeover(item, settings)) {
    handoffAttempted.add(item.id);  // Idempotency: one attempt per download id

    try {
      const job = await bridgeManager.sendCandidate(candidate);
      // Only cancel the browser download if NOVA confirmed acceptance.
      // 'sent' = delivered to NOVA; 'pending' = persisted in outbox for guaranteed delivery.
      if (job?.status === 'sent' || job?.status === 'pending') {
        if (browser.downloads?.cancel) {
          await catchAndLog(browser.downloads.cancel(item.id), 'download-interceptor:cancel');
        }
      }
      // If NOVA failed (job.status === failed/dead-letter), browser download continues naturally.
    } catch {
      // NOVA handoff failed; browser download continues.
    }
    return;
  }

  // Auto-send without takeover (existing behaviour for non-takeover items)
  if (engine.shouldAutoSend(candidate)) {
    const outbox = new OutboxStore();
    const counts = await outbox.counts();
    if (counts.pending < 50) {
      catchAndIgnore(bridgeManager.sendCandidate(candidate), 'download-interceptor:send-auto');
    }
  }
}
