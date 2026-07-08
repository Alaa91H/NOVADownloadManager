import browser from 'webextension-polyfill';
import { bridgeManager } from '../bridge/bridge-manager';
import { CandidatePipeline } from '../capture/candidate-pipeline';
import { RuntimeMessage, RuntimeMessageSchema, SiteRulesImportSchema } from '../contracts/messages.schema';
import { AGGRESSIVE_MAX_SCAN_HTML_CHARS, AGGRESSIVE_MAX_SCAN_JSON_LD_ITEMS, AGGRESSIVE_MAX_SCAN_JSON_LD_SCRIPT_CHARS, AGGRESSIVE_MAX_SCAN_JSON_LD_TOTAL_CHARS, AGGRESSIVE_MAX_SCAN_LINKS, AGGRESSIVE_MAX_SCAN_MEDIA, AGGRESSIVE_MAX_SCAN_OPEN_GRAPH, AGGRESSIVE_MAX_SCAN_REQUESTS_PER_TAB_PER_MINUTE, IDEMPOTENCY_SCHEMA_VERSION, MAX_CANDIDATES_PER_TAB, MAX_CANDIDATE_CACHE_BYTES_PER_TAB, MAX_DIAGNOSTICS_EXPORT_BYTES, MAX_EVENT_MESSAGE_BYTES, MAX_EVENT_PARSE_ERRORS_PER_CONNECTION, MAX_HANDOFF_CANDIDATES, MAX_HANDOFF_PAYLOAD_BYTES, MAX_HTTP_REQUEST_PAYLOAD_BYTES, MAX_HTTP_RESPONSE_BYTES, MAX_NATIVE_MESSAGE_BYTES, MAX_OUTBOX_JOBS, MAX_SCAN_HTML_CHARS, MAX_SCAN_JSON_LD_ITEMS, MAX_SCAN_JSON_LD_SCRIPT_CHARS, MAX_SCAN_JSON_LD_TOTAL_CHARS, MAX_SCAN_LINKS, MAX_SCAN_MEDIA, MAX_SCAN_OPEN_GRAPH, MAX_SCAN_REQUESTS_PER_TAB_PER_MINUTE, MAX_SETTINGS_IMPORT_BYTES, MAX_SITE_RULES, MAX_SITE_RULES_IMPORT_BYTES, MAX_SSE_BUFFER_BYTES, MAX_RUNTIME_MESSAGE_BYTES, MAX_TASK_ID_CHARS, OUTBOX_DEAD_LETTER_RETENTION_DAYS, OUTBOX_SENT_RETENTION_DAYS } from '../contracts/limits';
import { migrateSettingsInput, SettingsSchema, type Settings } from '../contracts/settings.schema';
import type { Candidate } from '../contracts/candidate.schema';
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
import { handoffPolicyDecision } from '../security/handoff-policy';
import { updateBadge } from './badge';
import { getActiveTabId, scanTab } from './tab-scanner';
import { platformRegistry } from '../platforms/platform-registry';
import { assertScanRateLimit, assertUserActivatedScan, assertOverlayScanSender, RuntimeMessageSenderLike } from '../security/page-scan-policy';
import { assertRuntimeMessageAllowed } from '../security/runtime-message-policy';
import { assertStorageBudget } from '../security/storage-budget';
import { catchAndLog } from '../core/safe-catch';
import { assertRuntimeMessageBudget } from '../security/runtime-message-budget';
import { registerNetworkObserver } from './network-observer';
import { registerDownloadInterceptor } from './download-interceptor';
import { AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE } from '../profiles/aggressive-capture-profile';
import { enforceAggressivePermissions, getAggressivePermissionIntegrity } from '../profiles/aggressive-permission-enforcer';
import { analyzeOverlayCandidates, isSmartVideoPage, prepareSmartVideoCandidates, mergeLiveOverlayCandidateSet, buildOverlayScanMessage, mediaTypeFromPageTapHint, buildPageTapFilename, OverlayScanContentLike } from './overlay-candidate-analyzer';

const cache = new CandidateCache();
const pipeline = new CandidatePipeline();
const outbox = new OutboxStore();
const settingsStore = new SettingsStore();
const siteRulesStore = new SiteRulesStore();
const permissionPolicy = new PermissionPolicy();
const migrationStore = new MigrationStore();
const OVERLAY_DIAGNOSTICS_STORAGE_KEY = 'nova.downloadOverlayDiagnostics.v1';



browser.runtime.onMessage.addListener((raw: unknown, sender: RuntimeMessageSenderLike): Promise<unknown> => {
  try {
    assertRuntimeMessageBudget(raw);
  } catch (error) {
    return Promise.resolve(normalizeRouterError(error));
  }
  const parsed = RuntimeMessageSchema.safeParse(raw);
  if (!parsed.success) return Promise.resolve({ ok: false, code: 'VALIDATION_FAILED', message: 'Runtime message schema validation failed.', issues: parsed.error.issues });
  return dispatchMessage(parsed.data, sender).catch((error) => normalizeRouterError(error));
});

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
      return overlayScanPage(sender);
    case 'OVERLAY_REFRESH_CANDIDATES':
      return overlayRefreshCandidates(sender);
    case 'OVERLAY_SEND_SELECTED':
      return overlaySendSelected(sender, msg.candidateIds);
    case 'PAGE_TAP_CANDIDATES_FOUND':
      return handlePageTapCandidates(msg.events, sender);
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
    case 'OPEN_OPTIONS':
      return openOptions();
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
  await cache.set(activeTabId, candidates);
  return { ok: true, candidates, capturedAt: content.capturedAt };
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


async function overlayScanPage(sender?: RuntimeMessageSenderLike): Promise<unknown> {
  const tabId = assertOverlayScanSender(sender);
  const settings = await settingsStore.get();
  const scanProfile = settings.capture.aggressiveMode ? 'aggressive' : 'standard';
  assertScanRateLimit(tabId, Date.now(), scanProfile);
  const content = await scanTab(tabId, scanProfile);
  const scannedCandidates = await pipeline.run({ tabId, pageUrl: content.url, content, userActivated: true });
  const cachedCandidates = await cache.merge(tabId, scannedCandidates, { notify: false, reason: 'overlay-scan-dom' });
  const candidates = mergeLiveOverlayCandidateSet(cachedCandidates, scannedCandidates);
  return buildOverlayPickerResponse(tabId, settings, candidates, {
    content,
    capturedAt: content.capturedAt,
    diagnosticKey: 'lastScan',
    source: 'scan',
    scanProfile,
  });
}

async function overlayRefreshCandidates(sender?: RuntimeMessageSenderLike): Promise<unknown> {
  const tabId = assertOverlayScanSender(sender);
  const settings = await settingsStore.get();
  const candidates = await cache.get(tabId);
  return buildOverlayPickerResponse(tabId, settings, candidates, {
    content: { url: sender?.url },
    capturedAt: new Date().toISOString(),
    diagnosticKey: 'lastRefresh',
    source: 'cache-refresh',
    scanProfile: 'cache-only',
  });
}

type OverlayPickerResponseOptions = {
  content: OverlayScanContentLike;
  capturedAt?: string;
  diagnosticKey: 'lastScan' | 'lastRefresh';
  source: 'scan' | 'cache-refresh';
  scanProfile: string;
};

// Regression guard for source-inspection tests: scan diagnostics are still recorded
// as writeOverlayDiagnostics({ lastScan: ... }); cache-only picker refreshes use lastRefresh.
async function buildOverlayPickerResponse(
  tabId: number,
  settings: Settings,
  candidates: Candidate[],
  options: OverlayPickerResponseOptions,
): Promise<unknown> {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const smartVideoMode = Boolean(
    settings.overlay.smartVideoOnlyOnVideoPages && isSmartVideoPage(options.content, candidates),
  );
  const overlayAnalysis = analyzeOverlayCandidates(candidates, settings, smartVideoMode);
  const accepted = smartVideoMode
    ? prepareSmartVideoCandidates(overlayAnalysis.accepted, options.content.title)
    : overlayAnalysis.accepted;
  const handoffableCandidates = accepted.filter((candidate) => handoffPolicyDecision(candidate).allowed);
  const nonHandoffable = Math.max(0, accepted.length - handoffableCandidates.length);
  const pickerSourceCandidates = handoffableCandidates;
  const pickerLimit = smartVideoMode
    ? Math.min(settings.overlay.maxPickerItems, settings.overlay.smartVideoMaxItems)
    : settings.overlay.maxPickerItems;
  const clipped = Math.max(0, pickerSourceCandidates.length - pickerLimit);
  const pickerCandidates = pickerSourceCandidates.slice(0, pickerLimit);
  const cachedIds = new Set(candidates.map((candidate) => candidate.id));
  const hasUnpersistedPickerCandidate = pickerCandidates.some((candidate) => !cachedIds.has(candidate.id));
  if (hasUnpersistedPickerCandidate) {
    await cache.set(tabId, mergeLiveOverlayCandidateSet(candidates, pickerCandidates));
  }
  const diagnostics = {
    capturedAt,
    scanProfile: options.scanProfile,
    source: options.source,
    smartVideoMode,
    totalCandidates: candidates.length,
    visibleCandidates: pickerCandidates.length,
    overlayFilteredOut: Math.max(0, candidates.length - overlayAnalysis.accepted.length),
    nonHandoffable,
    clipped,
    pickerLimit,
    filterReasons: overlayAnalysis.filterReasons,
  };
  await writeOverlayDiagnostics({ [options.diagnosticKey]: diagnostics });
  return {
    ok: true,
    candidates: pickerCandidates,
    totalCandidates: candidates.length,
    filteredOut: Math.max(0, candidates.length - pickerCandidates.length),
    overlayFilteredOut: diagnostics.overlayFilteredOut,
    nonHandoffable,
    clipped,
    smartVideoMode,
    filterReasons: overlayAnalysis.filterReasons,
    message: buildOverlayScanMessage(
      candidates.length,
      pickerCandidates.length,
      diagnostics.overlayFilteredOut,
      nonHandoffable,
      clipped,
      smartVideoMode,
    ),
    capturedAt,
    cacheOnly: options.source === 'cache-refresh',
  };
}

// OVERLAY_SEND_SELECTED: send the user's chosen candidates (by id) from the in-page picker.
// Bound to sender.tab.id: candidates are read from that tab's cache and filtered by the trusted
// handoff policy, so the page can only hand off what it actually captured, and never a
// non-handoffable (e.g. blob:/DRM) URL.
async function overlaySendSelected(sender: RuntimeMessageSenderLike | undefined, candidateIds: string[]): Promise<unknown> {
  const tabId = assertOverlayScanSender(sender);
  const candidates = await cache.get(tabId);
  const wanted = new Set(candidateIds);
  const chosen = candidates.filter((c) => wanted.has(c.id) && handoffPolicyDecision(c).allowed).slice(0, MAX_HANDOFF_CANDIDATES);
  if (chosen.length === 0) {
    await writeOverlayDiagnostics({ lastSend: { sentAt: new Date().toISOString(), requested: candidateIds.length, sent: 0, failed: true, reason: 'no-handoffable-selection' } });
    throw new NovaExtensionError({ code: 'VALIDATION_FAILED', message: 'None of the selected candidates are handoffable for this tab.', retryable: false });
  }
  await bridgeManager.sendBatch(chosen).then(async () => { await maybeOpenNova(); });
  await writeOverlayDiagnostics({ lastSend: { sentAt: new Date().toISOString(), requested: candidateIds.length, sent: chosen.length, failed: false } });
  return { ok: true, sent: chosen.length };
}





async function writeOverlayDiagnostics(patch: Record<string, unknown>): Promise<void> {
  try {
    const current = await browser.storage.local.get(OVERLAY_DIAGNOSTICS_STORAGE_KEY);
    const existing = current[OVERLAY_DIAGNOSTICS_STORAGE_KEY];
    const safeExisting = existing && typeof existing === 'object' ? existing as Record<string, unknown> : {};
    await browser.storage.local.set({ [OVERLAY_DIAGNOSTICS_STORAGE_KEY]: { ...safeExisting, ...patch, updatedAt: new Date().toISOString() } });
  } catch {
    // Diagnostics are best effort and must never block user-triggered scanning or sending.
  }
}


async function clearCandidates(tabId?: number): Promise<{ ok: true }> {
  const activeTabId = await getActiveTabId(tabId);
  await cache.clear(activeTabId);
  return { ok: true };
}

async function updateSettings(partial: Record<string, unknown>): Promise<unknown> {
  const migratedPartial = migrateSettingsInput(partial) as Record<string, unknown>;
  assertStorageBudget('settings-import', migratedPartial);
  const current = await settingsStore.get();
  const next = SettingsSchema.parse({
    ...current,
    ...migratedPartial,
    capture: { ...current.capture, ...(typeof migratedPartial.capture === 'object' && migratedPartial.capture ? migratedPartial.capture : {}) },
    overlay: { ...current.overlay, ...(typeof migratedPartial.overlay === 'object' && migratedPartial.overlay ? migratedPartial.overlay : {}) },
    popup: { ...current.popup, ...(typeof migratedPartial.popup === 'object' && migratedPartial.popup ? migratedPartial.popup : {}) },
  });
  if (next.capture.aggressiveMode) await assertAggressiveAllSitesAccess();
  await settingsStore.set(next);
  if (next.capture.aggressiveMode || next.capture.network) catchAndLog(registerNetworkObserver(), 'message-router:register-network-observer');
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
      repairHint: 'Open Options > Capture and grant the aggressive all-sites permission bundle from the browser prompt.',
      details: AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE,
    });
  }
}

async function exportSettings(): Promise<unknown> {
  const [settings, siteRules] = await Promise.all([settingsStore.get(), siteRulesStore.list()]);
  return { settings, siteRules, exportedAt: new Date().toISOString(), version: 1 };
}

async function importSettings(settings: unknown): Promise<unknown> {
  const migratedSettings = migrateSettingsInput(settings);
  assertStorageBudget('settings-import', migratedSettings);
  // Imports come from user-supplied JSON, so validate defensively and surface a
  // clean VALIDATION_FAILED error instead of letting a raw ZodError propagate.
  const result = SettingsSchema.safeParse(migratedSettings);
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
  if (parsed.capture.aggressiveMode || parsed.capture.network) catchAndLog(registerNetworkObserver(), 'message-router:register-network-observer-import');
  if (parsed.capture.aggressiveMode || parsed.capture.downloads) registerDownloadInterceptor();
  return parsed;
}

async function diagnostics(): Promise<unknown> {
  const [base, siteRules, browserInfo, storageMigration, aggressiveIntegrity, settings, overlayPositions, overlayRuntime] = await Promise.all([bridgeManager.getDiagnostics(), siteRulesStore.list(), getBrowserInfo(), migrationStore.status(), getAggressivePermissionIntegrity(), settingsStore.get(), overlayPositionDiagnostics(), overlayRuntimeDiagnostics()]);
  const manifest = browser.runtime.getManifest();
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
    overlay: {
      enabled: settings.overlay.enabled,
      preset: settings.overlay.preset,
      defaultPosition: settings.overlay.defaultPosition,
      positionScope: settings.overlay.positionScope,
      openDirection: settings.overlay.openDirection,
      showOnlyWhenCandidates: settings.overlay.showOnlyWhenCandidates,
      hideWhenFiltersRejectAll: settings.overlay.hideWhenFiltersRejectAll,
      minConfidence: settings.overlay.minConfidence,
      minFileSizeMB: settings.overlay.minFileSizeMB,
      maxFileSizeMB: settings.overlay.maxFileSizeMB,
      smartVideoOnlyOnVideoPages: settings.overlay.smartVideoOnlyOnVideoPages,
      smartVideoMaxItems: settings.overlay.smartVideoMaxItems,
      smartVideoContinuousRefresh: settings.overlay.smartVideoContinuousRefresh,
      smartVideoRefreshMs: settings.overlay.smartVideoRefreshMs,
      mediaTypes: settings.overlay.mediaTypes,
      extensionAllowlistCount: settings.overlay.extensionsAllowlist.length,
      extensionBlocklistCount: settings.overlay.extensionsBlocklist.length,
      savedPositions: overlayPositions,
      runtime: overlayRuntime,
    },
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

async function overlayPositionDiagnostics(): Promise<Record<string, number | boolean>> {
  try {
    const all = await browser.storage.local.get(null);
    const keys = Object.keys(all);
    const scoped = keys.filter((key) => key.startsWith('nova.downloadOverlayPosition.v2.')).length;
    return {
      legacyGlobalPresent: Object.prototype.hasOwnProperty.call(all, 'nova.videoOverlayPosition.v1'),
      scopedPositions: scoped,
      totalPositions: scoped + (Object.prototype.hasOwnProperty.call(all, 'nova.videoOverlayPosition.v1') ? 1 : 0),
    };
  } catch {
    return { legacyGlobalPresent: false, scopedPositions: 0, totalPositions: 0 };
  }
}

async function overlayRuntimeDiagnostics(): Promise<Record<string, unknown>> {
  try {
    const stored = await browser.storage.local.get(OVERLAY_DIAGNOSTICS_STORAGE_KEY);
    const value = stored[OVERLAY_DIAGNOSTICS_STORAGE_KEY];
    return value && typeof value === 'object' ? redact(value) as Record<string, unknown> : {};
  } catch {
    return {};
  }
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
    | 'overlay-diagnostics'
    | 'overlay-positions'
    | 'outbox-terminal'
    | 'all-local',
): Promise<{ ok: true }> {
  if (scope === 'candidate-cache' || scope === 'all-local') await cache.clearAll();
  if (scope === 'outbox-terminal') await outbox.clearTerminal();

  const all =
    scope === 'overlay-positions' || scope === 'diagnostics' || scope === 'all-local'
      ? await catchAndLog(browser.storage.local.get(null), 'clear-local-data') ?? {}
      : {};
  const overlayPositionKeys = Object.keys(all).filter(
    (key) => key === 'nova.videoOverlayPosition.v1' || key.startsWith('nova.downloadOverlayPosition.v2.'),
  );

  if (scope === 'diagnostics' || scope === 'overlay-diagnostics' || scope === 'all-local') {
    await browser.storage.local.remove([OVERLAY_DIAGNOSTICS_STORAGE_KEY, 'nova.diagnostics']);
  }

  if (scope === 'overlay-positions' || scope === 'all-local') {
    await browser.storage.local.remove(
      overlayPositionKeys.length > 0 ? overlayPositionKeys : ['nova.videoOverlayPosition.v1'],
    );
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

async function openOptions(): Promise<{ ok: true }> {
  try {
    await browser.runtime.openOptionsPage();
  } catch {
    await browser.tabs.create({ url: browser.runtime.getURL('options.html') });
  }
  return { ok: true };
}

async function maybeOpenNova(captureUrl?: string): Promise<void> {
  const settings = await settingsStore.get();
  if (settings.openNovaAfterSend) await openNova(captureUrl);
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
