import browser from 'webextension-polyfill';
import { networkEntryToCandidate } from '../capture/network-capture';
import { MetadataEnricher } from '../pipeline/metadata-enricher';
import { RuleEngine } from '../rules/rule-engine';
import { safeHeaders } from '../security/safe-headers';
import { CandidateCache } from '../storage/candidate-cache';
import { SettingsStore } from '../storage/settings-store';
import { SiteRulesStore } from '../storage/site-rules-store';
import { catchAndLog, catchAndIgnore } from '../core/safe-catch';

type HeaderLike = { name: string; value?: string; binaryValue?: number[] };
type HeadersDetailsLike = { url: string; tabId?: number; responseHeaders?: HeaderLike[]; documentUrl?: string; originUrl?: string; type?: string };
type RedirectDetailsLike = { url: string; redirectUrl?: string; tabId?: number; documentUrl?: string; originUrl?: string };

let networkObserverRegistered = false;

const headerQueue = new Map<number, { entries: HeadersDetailsLike[]; timer: ReturnType<typeof setTimeout> | undefined }>();
const DEBOUNCE_MS = 80;
const MAX_BATCH_SIZE = 50;

function flushTabQueue(tabId: number): void {
  const entry = headerQueue.get(tabId);
  if (!entry) return;
  headerQueue.delete(tabId);
  const batch = entry.entries.splice(0, MAX_BATCH_SIZE);
  if (batch.length === 0) return;
  catchAndIgnore(processBatch(tabId, batch), 'network-observer:flush-batch');
  if (entry.entries.length > 0) {
    entry.timer = setTimeout(() => flushTabQueue(tabId), DEBOUNCE_MS);
  }
}

function enqueueHeaders(details: HeadersDetailsLike): void {
  const tabId = details.tabId;
  if (typeof tabId !== 'number' || tabId < 0) return;
  let entry = headerQueue.get(tabId);
  if (!entry) {
    entry = { entries: [], timer: undefined };
    headerQueue.set(tabId, entry);
  }
  entry.entries.push(details);
  if (entry.entries.length >= MAX_BATCH_SIZE) {
    if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined; }
    flushTabQueue(tabId);
  } else if (entry.timer === undefined) {
    entry.timer = setTimeout(() => flushTabQueue(tabId), DEBOUNCE_MS);
  }
}

async function processBatch(tabId: number, batch: HeadersDetailsLike[]): Promise<void> {
  const seen = new Set<string>();
  const candidates: import('../contracts/candidate.schema').Candidate[] = [];
  const now = new Date().toISOString();
  for (const details of batch) {
    const rawHeaders: Record<string, string> = {};
    for (const header of details.responseHeaders ?? []) {
      if (header.value) rawHeaders[header.name.toLowerCase()] = header.value;
    }
    const headers = safeHeaders(rawHeaders);
    if (Object.keys(headers).length === 0) continue;
    const entryUrl = details.url;
    if (seen.has(entryUrl)) continue;
    seen.add(entryUrl);
    candidates.push(new MetadataEnricher().enrich(networkEntryToCandidate({
      url: entryUrl,
      pageUrl: details.documentUrl ?? details.originUrl,
      referrer: details.originUrl,
      headers,
      tabId,
    }, now)));
  }
  if (candidates.length === 0) return;
  const settings = await new SettingsStore().get();
  const rules = await new SiteRulesStore().list();
  const minimumConfidence = settings.capture.aggressiveMode ? 1 : 20;
  const filtered = candidates.filter((c) => c.confidence >= minimumConfidence && new RuleEngine(rules).shouldShow(c));
  if (filtered.length > 0) await new CandidateCache().merge(tabId, filtered, { reason: 'network-headers' });
}

export async function registerNetworkObserver(): Promise<void> {
  if (networkObserverRegistered) return;
  const settings = await new SettingsStore().get();
  if (!settings.enabled || (!settings.capture.network && !settings.capture.aggressiveMode)) return;
  const hasPermission = await catchAndLog(browser.permissions.contains({ permissions: ['webRequest'], origins: ['<all_urls>'] }), 'network-observer:permissions') ?? false;
  if (!hasPermission || !browser.webRequest?.onHeadersReceived) return;
  browser.webRequest.onHeadersReceived.addListener(
    (details: HeadersDetailsLike) => {
      enqueueHeaders(details);
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  );
  browser.webRequest.onBeforeRedirect?.addListener(
    (details: RedirectDetailsLike) => {
      catchAndIgnore(captureRedirect(details), 'network-observer:capture-redirect');
    },
    { urls: ['<all_urls>'] },
  );
  networkObserverRegistered = true;
}

async function captureRedirect(details: RedirectDetailsLike): Promise<void> {
  if (typeof details.tabId !== 'number' || details.tabId < 0 || !details.redirectUrl) return;
  const candidate = new MetadataEnricher().enrich(networkEntryToCandidate({
    url: details.url,
    finalUrl: details.redirectUrl,
    pageUrl: details.documentUrl ?? details.originUrl,
    referrer: details.originUrl,
    tabId: details.tabId,
  }, new Date().toISOString()));
  const rules = await new SiteRulesStore().list();
  if (new RuleEngine(rules).shouldShow(candidate)) await new CandidateCache().merge(details.tabId, [candidate], { reason: 'network-redirect' });
}
