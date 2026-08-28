import browser from 'webextension-polyfill';
import { bridgeManager } from '../bridge/bridge-manager';
import { CandidatePipeline } from '../capture/candidate-pipeline';
import { type RuntimeMessage, RuntimeMessageSchema, SiteRulesImportSchema } from '../contracts/messages.schema';
import { AGGRESSIVE_MAX_SCAN_HTML_CHARS, AGGRESSIVE_MAX_SCAN_JSON_LD_ITEMS, AGGRESSIVE_MAX_SCAN_JSON_LD_SCRIPT_CHARS, AGGRESSIVE_MAX_SCAN_JSON_LD_TOTAL_CHARS, AGGRESSIVE_MAX_SCAN_LINKS, AGGRESSIVE_MAX_SCAN_MEDIA, AGGRESSIVE_MAX_SCAN_OPEN_GRAPH, AGGRESSIVE_MAX_SCAN_REQUESTS_PER_TAB_PER_MINUTE, IDEMPOTENCY_SCHEMA_VERSION, MAX_CANDIDATES_PER_TAB, MAX_CANDIDATE_CACHE_BYTES_PER_TAB, MAX_DIAGNOSTICS_EXPORT_BYTES, MAX_EVENT_MESSAGE_BYTES, MAX_EVENT_PARSE_ERRORS_PER_CONNECTION, MAX_HANDOFF_CANDIDATES, MAX_HANDOFF_PAYLOAD_BYTES, MAX_HTTP_REQUEST_PAYLOAD_BYTES, MAX_HTTP_RESPONSE_BYTES, MAX_NATIVE_MESSAGE_BYTES, MAX_OUTBOX_JOBS, MAX_SCAN_HTML_CHARS, MAX_SCAN_JSON_LD_ITEMS, MAX_SCAN_JSON_LD_SCRIPT_CHARS, MAX_SCAN_JSON_LD_TOTAL_CHARS, MAX_SCAN_LINKS, MAX_SCAN_MEDIA, MAX_SCAN_OPEN_GRAPH, MAX_SCAN_REQUESTS_PER_TAB_PER_MINUTE, MAX_SETTINGS_IMPORT_BYTES, MAX_SITE_RULES, MAX_SITE_RULES_IMPORT_BYTES, MAX_SSE_BUFFER_BYTES, MAX_RUNTIME_MESSAGE_BYTES, MAX_TASK_ID_CHARS, OUTBOX_DEAD_LETTER_RETENTION_DAYS, OUTBOX_SENT_RETENTION_DAYS } from '../contracts/limits';
import { SettingsSchema } from '../contracts/settings.schema';
import { ListTasksResponseSchema } from '../contracts/runtime-response.schema';
import { classifyByUrl, mediaTypeFromMime } from '../pipeline/mime-detector';
import { extensionOf } from '../utils/url';
import { domLinkEvidence } from '../pipeline/evidence';
import { MetadataEnricher } from '../pipeline/metadata-enricher';
import { idempotencyKeyFor } from '../outbox/idempotency';
import { OutboxStore } from '../outbox/outbox-store';
import { PermissionPolicy } from '../rules/permission-policy';
import { CandidateCache } from '../storage/candidate-cache';
import { SettingsStore } from '../storage/settings-store';
import { MigrationStore } from '../storage/migration-store';
import { SiteRulesStore } from '../storage/site-rules-store';
import { TokenStore } from '../storage/token-store';
import { NovaExtensionError, toNovaExtensionError } from '../core/error-classification';
import { redact } from '../security/redaction';
import { updateBadge } from './badge';
import { getActiveTabId, scanTab } from './tab-scanner';
import { platformRegistry } from '../platforms/platform-registry';
import { assertScanRateLimit, assertUserActivatedScan, type RuntimeMessageSenderLike } from '../security/page-scan-policy';
import { assertRuntimeMessageAllowed } from '../security/runtime-message-policy';
import { assertStorageBudget } from '../security/storage-budget';
import { catchAndLog } from '../core/safe-catch';
import { assertRuntimeMessageBudget } from '../security/runtime-message-budget';
import { registerNetworkObserver } from './network-observer';
import { registerDownloadInterceptor, handleManualCapture } from './download-interceptor';
import { AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE } from '../profiles/aggressive-capture-profile';
import { enforceAggressivePermissions, getAggressivePermissionIntegrity } from '../profiles/aggressive-permission-enforcer';
import { mediaTypeFromPageTapHint, buildPageTapFilename } from './page-tap-utils';
import { waitForBackgroundInitialization } from './initialization-gate';

const cache = new CandidateCache();
const pipeline = new CandidatePipeline();
const outbox = new OutboxStore();
const settingsStore = new SettingsStore();
const siteRulesStore = new SiteRulesStore();
const permissionPolicy = new PermissionPolicy();
const migrationStore = new MigrationStore();



browser.runtime.onMessage.addListener((raw: unknown, sender: RuntimeMessageSenderLike): Promise<unknown> => {
  try {
    assertRuntimeMessageBudget(raw);
  } catch (error) {
    return Promise.resolve(normalizeRouterError(error));
  }
  const parsed = RuntimeMessageSchema.safeParse(raw);
  if (!parsed.success) return Promise.resolve({ ok: false, code: 'VALIDATION_FAILED', message: 'Runtime message schema validation failed.', issues: parsed.error.issues });
  // GET_BRIDGE_STATE is a passive snapshot and may be served immediately for
  // early UI paint. All mutations and capture work wait for migration/bootstrap
  // so a first-run storage migration cannot overwrite a just-saved preference
  // or race an intercepted download.
  const ready = parsed.data.type === 'GET_BRIDGE_STATE'
    ? Promise.resolve()
    : waitForBackgroundInitialization();
  return ready
    .then(() => dispatchMessage(parsed.data, sender))
    .catch((error) => normalizeRouterError(error));
});

async function directDownload(url: string, filename?: string): Promise<{ ok: boolean; downloadId?: number }> {
  try {
    const cleanFilename = filename?.replace(/[/\\:*?"<>|]/g, '_').trim();
    const downloadId = await browser.downloads.download({
      url,
      saveAs: false,
      conflictAction: 'uniquify',
      filename: cleanFilename || undefined,
    });
    if (downloadId !== undefined) {
      const displayName = cleanFilename || filename || url;
      trackDownload(downloadId, displayName);
      void notifyDownloadStarted(displayName);
    }
    return { ok: true, downloadId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Download failed: ${message}`, { cause: error });
  }
}

async function notifyDownloadStarted(name: string): Promise<void> {
  try {
    const shortName = name.length > 60 ? name.slice(0, 57) + '...' : name;
    void browser.notifications.create(`dl-${Date.now()}`, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-48.png'),
      title: 'Download Started',
      message: shortName,
    });
  } catch { /* notifications may be disabled */ }
}

const TRACKED_DOWNLOADS = new Map<number, string>();

function trackDownload(downloadId: number, filename: string): void {
  TRACKED_DOWNLOADS.set(downloadId, filename);
}

function initDownloadCompletionListener(): void {
  if (!browser.downloads?.onChanged) return;
  try {
    browser.downloads.onChanged.addListener((delta) => {
    if (delta.state?.current === 'complete' && typeof delta.id === 'number') {
      const filename = TRACKED_DOWNLOADS.get(delta.id);
      if (filename) {
        TRACKED_DOWNLOADS.delete(delta.id);
        const shortName = filename.length > 60 ? filename.slice(0, 57) + '...' : filename;
        void browser.notifications.create(`dl-complete-${delta.id}`, {
          type: 'basic',
          iconUrl: browser.runtime.getURL('icons/icon-48.png'),
          title: 'Download Complete',
          message: shortName,
        });
      }
    } else if (delta.state?.current === 'interrupted' && typeof delta.id === 'number') {
      const filename = TRACKED_DOWNLOADS.get(delta.id);
      if (filename) {
        TRACKED_DOWNLOADS.delete(delta.id);
        const shortName = filename.length > 60 ? filename.slice(0, 57) + '...' : filename;
        void browser.notifications.create(`dl-failed-${delta.id}`, {
          type: 'basic',
          iconUrl: browser.runtime.getURL('icons/icon-48.png'),
          title: 'Download Failed',
          message: shortName,
        });
      }
    }
  });
  } catch { /* fake-browser does not implement downloads.onChanged.addListener */ }
}

void initDownloadCompletionListener();

async function dispatchMessage(msg: RuntimeMessage, sender?: RuntimeMessageSenderLike): Promise<unknown> {
  assertRuntimeMessageAllowed(msg, sender);
  switch (msg.type) {
    case 'GET_BRIDGE_STATE':
      return bridgeManager.getState();
    case 'AUTO_CONNECT':
      return bridgeManager.autoConnect().then(async (state) => { await updateBadge(state); return state; });
    case 'RETRY_CONNECT':
      return bridgeManager.reconnect().then(async (state) => { await updateBadge(state); return state; });
    case 'RESET_PAIRING':
      return bridgeManager.repair().then(async (state) => { await updateBadge(state); return state; });
    case 'SCAN_PAGE':
      return scanCurrentPage(msg.tabId, Boolean(msg.userActivated), sender);
    case 'OVERLAY_SCAN_PAGE':
      return scanOverlayPage(sender);
    case 'OVERLAY_REFRESH_CANDIDATES':
      return overlayCachedCandidates(sender);
    case 'OVERLAY_SEND_SELECTED':
      return sendOverlaySelected(msg.candidateIds, sender);
    case 'OVERLAY_ANALYZE_MEDIA':
      return analyzeOverlayPage(sender);
    case 'OVERLAY_ADD_YTDLP_MEDIA':
      return addOverlayAnalyzedFormat(msg.formatId, sender);
    case 'PAGE_TAP_CANDIDATES_FOUND':
      return handlePageTapCandidates(msg.events, sender);
    case 'CAPTURE_DOWNLOAD':
      return handleCaptureDownload(msg.payload);
    case 'CAPTURE_CONTEXT_MENU':
      return pipeline.run({ tabId: msg.tabId, pageUrl: msg.pageUrl, linkUrl: msg.linkUrl, srcUrl: msg.srcUrl, selectionText: msg.selectionText, userActivated: true }, { includeContextMenu: true });
    case 'GET_CANDIDATES':
      return getActiveTabId(msg.tabId).then((tabId) => cache.get(tabId));
    case 'CLEAR_CANDIDATES':
      return clearCandidates(msg.tabId);
    case 'SEND_CANDIDATE':
      return bridgeManager.sendCandidate(msg.candidate);
    case 'SEND_BATCH':
      return bridgeManager.sendBatch(msg.candidates).then(async (job) => {
        const firstUrl = msg.candidates?.[0]?.finalUrl || msg.candidates?.[0]?.url || undefined;
        await maybeOpenNova(firstUrl);
        return job;
      });
    case 'RESOLVE_STREAM':
      return bridgeManager.resolveStream({ manifestType: msg.manifestType, url: msg.url, pageUrl: msg.pageUrl });
    case 'SEND_STREAM':
      return sendStream(msg.candidateId, msg.selectedQualityUrl, msg.selectedQuality);
    case 'PROBE_YTDLP':
      return bridgeManager.probeYtdlp(msg.url);
    case 'ADD_YTDLP_MEDIA':
      return addYtdlpMedia(msg);
    case 'ANALYZE_MEDIA':
      return bridgeManager.analyzeMedia(msg.url, msg.context);
    case 'DOWNLOAD_DIRECT':
      return directDownload(msg.url, msg.filename);
    case 'GET_OUTBOX_STATUS':
      return outbox.counts();
    case 'RUN_OUTBOX_RETRY':
      return bridgeManager.runOutboxOnce().then(() => outbox.counts());
    case 'GET_DIAGNOSTICS':
      return diagnostics();
    case 'GET_SETTINGS':
      await enforceAggressivePermissions('runtime.GET_SETTINGS');
      return settingsStore.get();
    case 'UPDATE_SETTINGS':
      return updateSettings(msg.settings);
    case 'EXPORT_SETTINGS':
      return exportSettings();
    case 'IMPORT_SETTINGS':
      return importSettings(msg.settings);
    case 'CLEAR_LOCAL_DATA':
      return clearLocalData(msg.scope);
    case 'GET_SITE_RULES':
      return siteRulesStore.list();
    case 'UPSERT_SITE_RULE':
      return siteRulesStore.upsert(msg.rule);
    case 'DELETE_SITE_RULE':
      return siteRulesStore.remove(msg.id).then(() => ({ ok: true }));
    case 'IMPORT_SITE_RULES':
      assertStorageBudget('site-rules-import', msg.rules);
      return siteRulesStore.setAll(SiteRulesImportSchema.parse(msg.rules)).then(() => ({ ok: true }));
    case 'EXPORT_SITE_RULES':
      return siteRulesStore.list();
    case 'REQUEST_PERMISSION':
      return permissionPolicy.request(msg.permissions, msg.origins);
    case 'GET_PERMISSION_STATUS':
      return permissionPolicy.detailedStatus();
    case 'PAUSE_TASK':
      return bridgeManager.pauseTask(msg.taskId);
    case 'RESUME_TASK':
      return bridgeManager.resumeTask(msg.taskId);
    case 'CANCEL_TASK':
      return bridgeManager.cancelTask(msg.taskId);
    case 'LIST_TASKS':
      return bridgeManager.listTasks().then((tasks) => ListTasksResponseSchema.parse({ ok: true, tasks }));
    case 'OPEN_NOVA':
      return openNova();
    case 'WAKE_UP_DESKTOP':
      return bridgeManager.wakeUpDesktop();
  }
}

// SCAN_PAGE security: Page scanning requires an explicit user action. The enforcement layer returns code: 'PERMISSION_MISSING' when the request is not trusted.
async function scanCurrentPage(tabId: number | undefined, userActivated: boolean, sender?: RuntimeMessageSenderLike): Promise<unknown> {
  assertUserActivatedScan(sender, userActivated);
  const activeTabId = await getActiveTabId(tabId);
  const settings = await settingsStore.get();
  const scanProfile = settings.capture.aggressiveMode ? 'aggressive' : 'standard';
  // Standard rate-limit guard string retained for regression tests: assertScanRateLimit(activeTabId);
  assertScanRateLimit(activeTabId, Date.now(), scanProfile);
  const content = await scanTab(activeTabId, scanProfile);
  const candidates = await pipeline.run({ tabId: activeTabId, pageUrl: content.url, content, userActivated });
  const merged = await cache.replaceWithScan(activeTabId, candidates);
  return { ok: true, candidates: merged, pageUrl: content.url, capturedAt: content.capturedAt };
}

type OverlayTabContext = { tabId: number; pageUrl: string };

function overlayTabContext(sender: RuntimeMessageSenderLike | undefined): OverlayTabContext {
  const tabId = sender?.tab?.id;
  const senderUrl = sender?.url;
  // `sender.url` proves the in-page content-script origin. When the browser
  // also gives us a tab URL, prefer that browser-owned top-level URL so an
  // embedded frame cannot steer analysis away from the page the user sees.
  const pageUrl = sender?.tab?.url ?? senderUrl;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0 || !senderUrl || !pageUrl) {
    throw new NovaExtensionError({
      code: 'PERMISSION_MISSING',
      message: 'The overlay must be attached to a trusted browser tab.',
      retryable: false,
      repairHint: 'Open the NOVA popup and retry.',
    });
  }
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
  } catch {
    throw new NovaExtensionError({
      code: 'VALIDATION_FAILED',
      message: 'The current page is not an HTTP(S) media page.',
      retryable: false,
      repairHint: 'Open the NOVA popup on a regular website and retry.',
    });
  }
  return { tabId, pageUrl };
}

async function scanOverlayPage(sender: RuntimeMessageSenderLike | undefined): Promise<unknown> {
  const { tabId } = overlayTabContext(sender);
  const settings = await settingsStore.get();
  const profile = settings.capture.aggressiveMode ? 'aggressive' : 'standard';
  assertScanRateLimit(tabId, Date.now(), profile);
  const content = await scanTab(tabId, profile);
  const candidates = await pipeline.run({ tabId, pageUrl: content.url, content, userActivated: true });
  const merged = await cache.replaceWithScan(tabId, candidates);
  return { ok: true, candidates: merged, pageUrl: content.url, capturedAt: content.capturedAt };
}

async function overlayCachedCandidates(sender: RuntimeMessageSenderLike | undefined): Promise<unknown> {
  const { tabId, pageUrl } = overlayTabContext(sender);
  return { ok: true, candidates: await cache.get(tabId), pageUrl };
}

async function sendOverlaySelected(candidateIds: string[], sender: RuntimeMessageSenderLike | undefined): Promise<unknown> {
  const { tabId } = overlayTabContext(sender);
  const requested = new Set(candidateIds);
  const selected = (await cache.get(tabId)).filter((candidate) => requested.has(candidate.id));
  if (selected.length === 0) {
    throw new NovaExtensionError({
      code: 'VALIDATION_FAILED',
      message: 'No selected overlay candidates are still available.',
      retryable: true,
      repairHint: 'Refresh the capture list and select a file again.',
    });
  }
  const job = await bridgeManager.sendBatch(selected);
  await maybeOpenNova(selected[0]?.pageUrl ?? selected[0]?.finalUrl ?? selected[0]?.url);
  return job;
}

async function analyzeOverlayPage(sender: RuntimeMessageSenderLike | undefined): Promise<unknown> {
  const { pageUrl } = overlayTabContext(sender);
  return bridgeManager.analyzeMedia(pageUrl, { pageUrl });
}

async function addOverlayAnalyzedFormat(formatId: string, sender: RuntimeMessageSenderLike | undefined): Promise<unknown> {
  const { pageUrl } = overlayTabContext(sender);
  // Do not trust an old overlay catalog or a delivery URL. Resolve the stable
  // page anew and submit only a current format id to the daemon-owned route.
  const analysis = await bridgeManager.analyzeMedia(pageUrl, { pageUrl });
  if (!analysis.ok || analysis.drmProtected) {
    throw new NovaExtensionError({
      code: 'VALIDATION_FAILED',
      message: 'The current media cannot be submitted for managed download.',
      retryable: false,
      repairHint: 'Review the media in the NOVA popup.',
    });
  }
  const selectedFormat = analysis.formats.find((format) => format.formatId === formatId);
  if (!selectedFormat) {
    throw new NovaExtensionError({
      code: 'VALIDATION_FAILED',
      message: 'The selected format is no longer available.',
      retryable: true,
      repairHint: 'Refresh video information and select a current format.',
    });
  }
  const seed = {
    id: `overlay-ytdlp-${formatId}`,
    url: pageUrl,
    pageUrl,
    source: 'platform' as const,
    mediaType: selectedFormat.hasVideo ? 'video' as const : 'audio' as const,
    width: selectedFormat.width,
    height: selectedFormat.height,
    bitrate: selectedFormat.bandwidth,
    sizeBytes: selectedFormat.estimatedSizeBytes,
    confidence: 100,
    createdAt: new Date().toISOString(),
  };
  const idempotencyKey = await idempotencyKeyFor([seed]);
  const result = await bridgeManager.addYtdlpMedia({
    idempotencyKey,
    url: pageUrl,
    pageUrl,
    title: analysis.title?.trim().slice(0, 512) || undefined,
    selectedFormat,
    drmProtected: false,
    source: 'nova-extension',
  });
  await maybeOpenNova();
  return result;
}

async function addYtdlpMedia(message: Extract<RuntimeMessage, { type: 'ADD_YTDLP_MEDIA' }>): Promise<unknown> {
  const format = message.selectedFormat;
  const mediaType: 'video' | 'audio' =
    format.hasVideo === false && format.hasAudio !== false ? 'audio' : 'video';
  const seed = {
    id: `ytdlp-${format.formatId ?? format.url}`,
    url: message.url,
    pageUrl: message.pageUrl,
    source: 'platform' as const,
    mediaType,
    width: format.width,
    height: format.height,
    bitrate: format.bandwidth,
    sizeBytes: format.estimatedSizeBytes ?? format.filesize,
    confidence: 100,
    createdAt: new Date().toISOString(),
  };
  const idempotencyKey = await idempotencyKeyFor([seed]);
  const result = await bridgeManager.addYtdlpMedia({
    idempotencyKey,
    url: message.url,
    title: message.title,
    pageUrl: message.pageUrl,
    referrer: message.referrer,
    selectedFormat: format,
    drmProtected: false,
    source: 'nova-extension',
  });
  // The quality click is already an explicit user confirmation. Open NOVA
  // without a capture parameter so the application is focused but does not
  // create a second capture-review dialog for the same page URL.
  await maybeOpenNova();
  return result;
}

// SEND_STREAM: build a stream.manifest candidate from a cached HLS/DASH candidate
// and hand it to NOVA with the user's chosen quality. NOVA owns the actual download.
async function sendStream(candidateId: string, selectedQualityUrl?: string, selectedQualityFromUi?: { url: string; width?: number; height?: number; bandwidth?: number; codecs?: string; label?: string; formatId?: string; estimatedSizeBytes?: number; container?: string; fps?: number; hasAudio?: boolean; hasVideo?: boolean }): Promise<unknown> {
  const activeTabId = await getActiveTabId();
  const candidates = await cache.get(activeTabId);
  const candidate = candidates.find((c) => c.id === candidateId);
  if (!candidate) {
    throw new NovaExtensionError({ code: 'VALIDATION_FAILED', message: 'Candidate not found in cache for this tab.', retryable: false });
  }
  const manifestType: 'hls' | 'dash' = candidate.source === 'dash-manifest' ? 'dash' : 'hls';
  const manifest = {
    kind: 'stream.manifest' as const,
    manifestType,
    url: candidate.finalUrl ?? candidate.url,
    pageUrl: candidate.pageUrl,
    referrer: candidate.referrer,
    headers: candidate.headers ? { contentType: candidate.headers.contentType, contentLength: candidate.headers.contentLength } : undefined,
    detectedBy: [candidate.source],
    evidence: candidate.evidence ?? [],
    drmProtected: Boolean(candidate.drm?.protected || candidate.metadata?.drmProtected),
    resolver: { preferred: 'desktop' as const, canRefresh: true, canMerge: true, canSelectQuality: true },
  };
  const selectedQuality = selectedQualityFromUi
    ?? (selectedQualityUrl
      ? (candidate.variants ?? []).filter((v) => v.url === selectedQualityUrl).map((v) => ({ url: v.url, width: v.width, height: v.height, bandwidth: v.bandwidth, codecs: v.codecs, label: v.label }))[0]
      : undefined);
  const baseKey = await idempotencyKeyFor([candidate]);
  const qualityKeyMaterial = JSON.stringify({
    // Only the UI-provided quality carries a formatId; variant fallbacks do not.
    formatId: selectedQuality && 'formatId' in selectedQuality ? selectedQuality.formatId : undefined,
    url: selectedQuality?.url,
    height: selectedQuality?.height,
    bandwidth: selectedQuality?.bandwidth,
    auto: !selectedQuality,
  });
  const qualityHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(qualityKeyMaterial));
  const qualityKey = [...new Uint8Array(qualityHash)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const idempotencyKey = `${baseKey}-${qualityKey}`;
  const result = await bridgeManager.addStream(manifest, selectedQuality, idempotencyKey);
  await maybeOpenNova();
  return result;
}

// PAGE_TAP_CANDIDATES_FOUND: convert page-tap events to candidates and store them.
async function handlePageTapCandidates(
  events: Array<{
    url: string;
    pageUrl: string;
    initiator: string;
    detectedAt: number;
    mimeHint?: string;
    extensionHint?: string;
    mediaHint?: string;
    sizeBytes?: number;
    width?: number;
    height?: number;
    bitrate?: number;
    durationSec?: number;
    qualityLabel?: string;
    itag?: string;
  }>,
  sender?: RuntimeMessageSenderLike,
): Promise<{ ok: true; accepted: number }> {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return { ok: true, accepted: 0 };
  const now = new Date().toISOString();
  const candidates = events.map((ev) => {
    const mediaType = mediaTypeFromMime(ev.mimeHint) ?? mediaTypeFromPageTapHint(ev.mediaHint) ?? classifyByUrl(ev.url);
    return {
      id: crypto.randomUUID(),
      url: ev.url,
      pageUrl: ev.pageUrl,
      source: 'dom' as const,
      mediaType,
      mimeType: ev.mimeHint,
      extension: ev.extensionHint ?? extensionOf(ev.url),
      sizeBytes: ev.sizeBytes,
      width: ev.width,
      height: ev.height,
      bitrate: ev.bitrate,
      durationSec: ev.durationSec,
      filename: buildPageTapFilename(ev),
      confidence: 0,
      createdAt: now,
      metadata: {
        assistiveSource: 'page-tap-live-quality',
        qualityLabel: ev.qualityLabel,
        itag: ev.itag,
        liveDetectedAt: ev.detectedAt,
      },
      evidence: [domLinkEvidence({ initiator: ev.initiator, via: 'page-tap', qualityLabel: ev.qualityLabel, itag: ev.itag })],
    };
  });
  const enricher = new MetadataEnricher();
  const enriched = candidates.map((c) => enricher.enrich(c));
  const pageTapUrl = events[0]?.pageUrl;
  for (const candidate of enriched) {
    const adapter = platformRegistry.forCDN(candidate.url) ?? (pageTapUrl ? platformRegistry.forURL(pageTapUrl) : undefined);
    if (adapter) {
      candidate.confidence = adapter.adjustConfidence(candidate);
      candidate.source = 'platform';
      candidate.metadata = { ...candidate.metadata, platform: adapter.id };
    }
  }
  await cache.merge(tabId, enriched);
  return { ok: true, accepted: enriched.length };
}


async function clearCandidates(tabId?: number): Promise<{ ok: true }> {
  const activeTabId = await getActiveTabId(tabId);
  await cache.clear(activeTabId);
  return { ok: true };
}

async function updateSettings(partial: Record<string, unknown>): Promise<unknown> {
  assertStorageBudget('settings-import', partial);
  const current = await settingsStore.get();
  const next = SettingsSchema.parse({
    ...current,
    ...partial,
    capture: { ...current.capture, ...(typeof partial.capture === 'object' && partial.capture ? partial.capture : {}) },
  });
  if (next.capture.aggressiveMode) await assertAggressiveAllSitesAccess();
  await settingsStore.set(next);
  if (next.capture.aggressiveMode || next.capture.network) catchAndLog(Promise.resolve(registerNetworkObserver()), 'message-router:register-network-observer');
  if (next.capture.aggressiveMode || next.capture.downloads) registerDownloadInterceptor();
  return next;
}


async function assertAggressiveAllSitesAccess(): Promise<void> {
  const granted = await permissionPolicy.has(AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions, AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins);
  if (!granted) {
    throw new NovaExtensionError({
      code: 'PERMISSION_MISSING',
      message: 'Aggressive Capture Mode requires browser all-sites access (<all_urls>) plus downloads, webRequest, scripting, and tabs permissions.',
      retryable: false,
      repairHint: 'Grant the aggressive all-sites permission bundle from the browser prompt when prompted.',
      details: AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE,
    });
  }
}

async function exportSettings(): Promise<unknown> {
  const [settings, siteRules] = await Promise.all([settingsStore.get(), siteRulesStore.list()]);
  return { settings, siteRules, exportedAt: new Date().toISOString(), version: 1 };
}

async function importSettings(settings: unknown): Promise<unknown> {
  assertStorageBudget('settings-import', settings);
  // Imports come from user-supplied JSON, so validate defensively and surface a
  // clean VALIDATION_FAILED error instead of letting a raw ZodError propagate.
  const result = SettingsSchema.safeParse(settings);
  if (!result.success) {
    throw new NovaExtensionError({
      code: 'VALIDATION_FAILED',
      message: 'Imported settings did not match the expected schema.',
      retryable: false,
      repairHint: 'Import a settings file exported by this extension.',
      details: { issues: result.error.issues },
    });
  }
  const parsed = result.data;
  if (parsed.capture.aggressiveMode) await assertAggressiveAllSitesAccess();
  await settingsStore.set(parsed);
  if (parsed.capture.aggressiveMode || parsed.capture.network) catchAndLog(Promise.resolve(registerNetworkObserver()), 'message-router:register-network-observer-import');
  if (parsed.capture.aggressiveMode || parsed.capture.downloads) registerDownloadInterceptor();
  return parsed;
}

async function diagnostics(): Promise<unknown> {
  const [base, siteRules, browserInfo, storageMigration, aggressiveIntegrity] = await Promise.all([bridgeManager.getDiagnostics(), siteRulesStore.list(), getBrowserInfo(), migrationStore.status(), getAggressivePermissionIntegrity()]);
  const manifest = browser.runtime.getManifest();
  const settings = await settingsStore.get();
  const diagnosticPayload = permissionPolicy.diagnostics({
    ...base,
    extension: {
      name: manifest.name,
      version: manifest.version,
      manifestVersion: manifest.manifest_version,
      buildTarget: typeof import.meta.env?.WXT_BROWSER === 'string' ? import.meta.env.WXT_BROWSER : 'unknown',
    },
    browser: browserInfo,
    storageMigration,
    activeSiteRules: siteRules.filter((rule) => rule.enabled).length,
    securityPolicy: {
      handoff: { maxCandidates: MAX_HANDOFF_CANDIDATES, maxPayloadBytes: MAX_HANDOFF_PAYLOAD_BYTES },
      localStorage: { maxCandidatesPerTab: MAX_CANDIDATES_PER_TAB, maxCandidateCacheBytesPerTab: MAX_CANDIDATE_CACHE_BYTES_PER_TAB, maxSettingsImportBytes: MAX_SETTINGS_IMPORT_BYTES, maxSiteRulesImportBytes: MAX_SITE_RULES_IMPORT_BYTES, maxDiagnosticsExportBytes: MAX_DIAGNOSTICS_EXPORT_BYTES },
      scanning: {
        maxHtmlChars: MAX_SCAN_HTML_CHARS,
        maxLinks: MAX_SCAN_LINKS,
        maxMedia: MAX_SCAN_MEDIA,
        maxOpenGraph: MAX_SCAN_OPEN_GRAPH,
        maxJsonLdItems: MAX_SCAN_JSON_LD_ITEMS,
        maxJsonLdScriptChars: MAX_SCAN_JSON_LD_SCRIPT_CHARS,
        maxJsonLdTotalChars: MAX_SCAN_JSON_LD_TOTAL_CHARS,
        maxRequestsPerTabPerMinute: MAX_SCAN_REQUESTS_PER_TAB_PER_MINUTE,
      },
      aggressiveCapture: {
        enabled: settings.capture.aggressiveMode,
        requiresAllSitesAccess: true,
        allSitesAccessGranted: aggressiveIntegrity.missingOrigins.length === 0,
        requiredPermissions: AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions,
        requiredOrigins: AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins,
        permissionIntegrity: aggressiveIntegrity,
        maxHtmlChars: AGGRESSIVE_MAX_SCAN_HTML_CHARS,
        maxLinks: AGGRESSIVE_MAX_SCAN_LINKS,
        maxMedia: AGGRESSIVE_MAX_SCAN_MEDIA,
        maxOpenGraph: AGGRESSIVE_MAX_SCAN_OPEN_GRAPH,
        maxJsonLdItems: AGGRESSIVE_MAX_SCAN_JSON_LD_ITEMS,
        maxJsonLdScriptChars: AGGRESSIVE_MAX_SCAN_JSON_LD_SCRIPT_CHARS,
        maxJsonLdTotalChars: AGGRESSIVE_MAX_SCAN_JSON_LD_TOTAL_CHARS,
        maxRequestsPerTabPerMinute: AGGRESSIVE_MAX_SCAN_REQUESTS_PER_TAB_PER_MINUTE,
      },
      siteRules: { maxRules: MAX_SITE_RULES },
      taskCommands: { maxTaskIdChars: MAX_TASK_ID_CHARS },
      permissionRequests: { allowlistedOnly: true, httpHttpsOriginsOnly: true },
      outboxRetention: { maxJobs: MAX_OUTBOX_JOBS, sentRetentionDays: OUTBOX_SENT_RETENTION_DAYS, deadLetterRetentionDays: OUTBOX_DEAD_LETTER_RETENTION_DAYS },
      events: { maxMessageBytes: MAX_EVENT_MESSAGE_BYTES, maxSseBufferBytes: MAX_SSE_BUFFER_BYTES, maxParseErrorsPerConnection: MAX_EVENT_PARSE_ERRORS_PER_CONNECTION, loopbackOnly: true },
      transportBudgets: { maxHttpRequestBytes: MAX_HTTP_REQUEST_PAYLOAD_BYTES, maxHttpResponseBytes: MAX_HTTP_RESPONSE_BYTES, maxNativeMessageBytes: MAX_NATIVE_MESSAGE_BYTES },
      idempotency: { schemaVersion: IDEMPOTENCY_SCHEMA_VERSION, canonicalized: true },
      runtimeMessages: { uiOnlyBridgeStateRead: true, uiOnlyDiagnosticsSettingsTasks: true, uiOnlyMutations: true, maxRuntimeMessageBytes: MAX_RUNTIME_MESSAGE_BYTES },
    },
  });
  assertStorageBudget('diagnostics-export', diagnosticPayload);
  return diagnosticPayload;
}

async function getBrowserInfo(): Promise<Record<string, unknown>> {
  const runtimeWithInfo = browser.runtime as typeof browser.runtime & { getBrowserInfo?: () => Promise<unknown> };
  if (typeof runtimeWithInfo.getBrowserInfo === 'function') {
    const info = await catchAndLog(runtimeWithInfo.getBrowserInfo(), 'get-browser-info');
    return info && typeof info === 'object' ? { ...(info as unknown as Record<string, unknown>) } : {};
  }
  return { userAgent: navigator.userAgent };
}

async function clearLocalData(
  scope:
    | 'candidate-cache'
    | 'diagnostics'
    | 'outbox-terminal'
    | 'all-local',
): Promise<{ ok: true }> {
  if (scope === 'candidate-cache' || scope === 'all-local') await cache.clearAll();
  if (scope === 'outbox-terminal') await outbox.clearTerminal();

  if (scope === 'diagnostics' || scope === 'all-local') {
    await browser.storage.local.remove(['nova.diagnostics']);
  }

  if (scope === 'all-local') {
    await Promise.all([
      outbox.clearAll(),
      siteRulesStore.clear(),
      new TokenStore().clear(),
      browser.storage.local.remove(['nova.settings', 'nova.bridgeState']),
    ]);
  }
  return { ok: true };
}

async function openNova(captureUrl?: string): Promise<{ ok: true }> {
  const baseUrl = 'http://127.0.0.1:3199';
  const url = captureUrl ? `${baseUrl}/?capture=${encodeURIComponent(captureUrl)}` : baseUrl;
  await browser.tabs.create({ url });
  return { ok: true };
}

async function maybeOpenNova(captureUrl?: string): Promise<void> {
  const settings = await settingsStore.get();
  if (settings.openNovaAfterSend) await openNova(captureUrl);
}

async function handleCaptureDownload(payload: { url: string; filename?: string; referrer?: string; source: string }): Promise<{ ok: boolean }> {
  try {
    return { ok: await handleManualCapture(payload) };
  } catch {
    return { ok: false };
  }
}

function normalizeRouterError(error: unknown): { ok: false; code: string; message: string; retryable?: boolean; repairHint?: string; details?: unknown } {
  const normalized = toNovaExtensionError(error);
  return {
    ok: false,
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    repairHint: normalized.repairHint,
    details: normalized.details === undefined ? undefined : redact(normalized.details),
  };
}
