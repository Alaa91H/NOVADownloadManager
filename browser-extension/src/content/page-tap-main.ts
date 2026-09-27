/**
 * page-tap-main — Phase 3.
 *
 * Runs in the MAIN (page) world at document_start. It patches fetch, XHR, and
 * HTMLMediaElement to intercept URLs before the page's own scripts consume them,
 * then forwards sanitised candidates via postMessage to the isolated content
 * script (page-tap-bridge.ts).
 *
 * SECURITY CONTRACT (non-negotiable):
 *  - No chrome.* / browser.* APIs used here.
 *  - No cookies, Authorization headers, or request bodies are forwarded.
 *  - No secrets or tokens are stored or forwarded.
 *  - No DRM bypass, no key extraction, and no license request/response capture.
 *  - Optional DRM detection only records key-system names and encrypted-media events.
 *  - Only URLs that match a safe downloadable extension/scheme are forwarded.
 *  - The postMessage target origin is '*' (same-origin enforcement is on the
 *    bridge side which validates source + type).
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  POST_SOURCE,
  POST_TYPE,
  POST_VERSION,
  DRM_CONFIG_TYPE,
  DRM_POST_TYPE,
  MAX_CONFIG_DEPTH,
  MAX_CONFIG_OBJECTS,
  MAX_CONFIG_KEYS_PER_OBJECT,
  MAX_CONFIG_STRING_VALUES,
  MAX_INITIAL_MEDIA_ELEMENTS,
  MAX_DOM_MUTATION_SCAN_ELEMENTS,
  MAX_PERFORMANCE_ENTRIES_PER_BATCH,
} from './page-tap-constants';
import type { Initiator, DrmSystem, DrmDetectionPayload } from './page-tap-constants';
import {
  resolveCandidateUrl,
  isLikelyInterestingUrl,
  canEmit,
  extensionOf,
  readStreamMetadata,
  isDownloadableUrl,
  mediaHintOf,
  isSmartStreamUrl,
} from './page-tap-url-utils';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const observedMediaElements = new WeakSet<HTMLMediaElement>();
const observedSourceElements = new WeakSet<HTMLSourceElement>();

// ---------------------------------------------------------------------------
// postMessage helper — sanitises before sending
// ---------------------------------------------------------------------------

function emit(
  url: string,
  initiator: Initiator,
  mimeHint?: string | null,
  contentLength?: string | null,
): void {
  const resolvedUrl = resolveCandidateUrl(url);
  if (!resolvedUrl) return;
  if (!isLikelyInterestingUrl(resolvedUrl, mimeHint)) return;
  if (!isDownloadableUrl(resolvedUrl, mimeHint)) return;
  if (!canEmit(resolvedUrl, initiator)) return;
  const meta = readStreamMetadata(resolvedUrl, mimeHint, contentLength);
  const ext = meta.extensionHint ?? extensionOf(resolvedUrl);
  const event = {
    source: POST_SOURCE,
    type: POST_TYPE,
    version: POST_VERSION,
    url: resolvedUrl,
    pageUrl: location.href,
    initiator,
    detectedAt: Date.now(),
    mimeHint: meta.mimeHint ?? undefined,
    extensionHint: ext ?? undefined,
    mediaHint: meta.mediaHint ?? mediaHintOf(resolvedUrl, ext, meta.mimeHint),
    sizeBytes: meta.sizeBytes,
    width: meta.width,
    height: meta.height,
    bitrate: meta.bitrate,
    durationSec: meta.durationSec,
    qualityLabel: meta.qualityLabel,
    itag: meta.itag,
  };
  try {
    window.postMessage(event, '*');
  } catch {
    // postMessage unavailable (e.g. sandboxed iframe) — silent fail
  }
}

// ---------------------------------------------------------------------------
// Optional DRM / encrypted-media detection (disabled until configured)
// ---------------------------------------------------------------------------

let drmDetectionInstalled = false;
const drmEmitDedupe = new Map<string, number>();
const DRM_EMIT_DEDUPE_TTL_MS = 5_000;

function drmSystemFromKeySystem(value?: string): DrmSystem | undefined {
  const keySystem = value?.toLowerCase() ?? '';
  if (!keySystem) return undefined;
  if (keySystem.includes('widevine')) return 'widevine';
  if (keySystem.includes('playready')) return 'playready';
  if (keySystem.includes('apple') || keySystem.includes('fairplay')) return 'fairplay';
  if (keySystem.includes('clearkey')) return 'clearkey';
  return 'unknown';
}

function emitDrmDetection(payload: DrmDetectionPayload): void {
  const now = Date.now();
  const key = `${payload.source}:${payload.keySystem ?? ''}:${payload.initDataType ?? ''}:${payload.reason}`;
  const previous = drmEmitDedupe.get(key);
  if (previous !== undefined && now - previous < DRM_EMIT_DEDUPE_TTL_MS) return;
  drmEmitDedupe.set(key, now);
  if (drmEmitDedupe.size > 80) {
    for (const [item, timestamp] of drmEmitDedupe) {
      if (now - timestamp > DRM_EMIT_DEDUPE_TTL_MS) drmEmitDedupe.delete(item);
    }
  }
  try {
    window.postMessage({
      source: POST_SOURCE,
      type: DRM_POST_TYPE,
      version: POST_VERSION,
      pageUrl: location.href,
      detectedAt: now,
      drm: {
        protected: true,
        system: payload.system ?? drmSystemFromKeySystem(payload.keySystem) ?? 'unknown',
        keySystem: payload.keySystem,
        source: payload.source,
        initDataType: payload.initDataType,
        licenseRequestObserved: payload.source === 'eme',
        downloadable: false,
        reason: payload.reason,
      },
    }, '*');
  } catch {
    // Best-effort only; never disturb page media playback.
  }
}

function patchRequestMediaKeySystemAccess(): void {
  type RequestMediaKeySystemAccessFn = NonNullable<(typeof navigator)['requestMediaKeySystemAccess']>;
  const nav = navigator as typeof navigator & { requestMediaKeySystemAccess?: RequestMediaKeySystemAccessFn };
  const original = nav.requestMediaKeySystemAccess;
  if (typeof original !== 'function') return;
  nav.requestMediaKeySystemAccess = function patchedRequestMediaKeySystemAccess(
    this: Navigator,
    ...args: Parameters<RequestMediaKeySystemAccessFn>
  ): ReturnType<RequestMediaKeySystemAccessFn> {
    try {
      emitDrmDetection({
        keySystem: String(args[0] ?? ''),
        source: 'eme',
        reason: 'Encrypted Media Extensions key-system access requested.',
      });
    } catch {
      // ignore
    }
    return original.apply(this, args) as ReturnType<RequestMediaKeySystemAccessFn>;
  } as RequestMediaKeySystemAccessFn;
}

function patchMediaElementSetMediaKeys(): void {
  const proto = HTMLMediaElement.prototype as typeof HTMLMediaElement.prototype & {
    setMediaKeys?: (mediaKeys: unknown) => Promise<void>;
  };
  const original = proto.setMediaKeys;
  if (typeof original !== 'function') return;
  proto.setMediaKeys = function patchedSetMediaKeys(mediaKeys: unknown): Promise<void> {
    try {
      if (mediaKeys) {
        emitDrmDetection({
          source: 'eme',
          reason: 'Encrypted Media Extensions MediaKeys attached to a media element.',
        });
      }
    } catch {
      // ignore
    }
    return original.apply(this, [mediaKeys]);
  };
}

function patchMediaKeySessionGenerateRequest(): void {
  const mediaKeySessionCtor = (globalThis as unknown as {
    MediaKeySession?: { prototype?: { generateRequest?: (initDataType: string, initData: unknown) => Promise<void> } };
  }).MediaKeySession;
  const proto = mediaKeySessionCtor?.prototype;
  const original = proto?.generateRequest;
  if (!proto || typeof original !== 'function') return;
  proto.generateRequest = function patchedGenerateRequest(initDataType: string, initData: unknown): Promise<void> {
    try {
      emitDrmDetection({
        source: 'eme',
        initDataType: typeof initDataType === 'string' ? initDataType : undefined,
        reason: 'Encrypted Media Extensions license challenge generation requested.',
      });
    } catch {
      // Never read or forward initData bytes.
      void initData;
    }
    return original.apply(this, [initDataType, initData]);
  };
}

function observeEncryptedMediaEvents(): void {
  document.addEventListener('encrypted', (event) => {
    const encryptedEvent = event as Event & { initDataType?: string };
    emitDrmDetection({
      source: 'encrypted-event',
      initDataType: typeof encryptedEvent.initDataType === 'string' ? encryptedEvent.initDataType : undefined,
      reason: 'HTMLMediaElement encrypted event observed.',
    });
  }, true);
}

function installDrmDetectionHooks(): void {
  if (drmDetectionInstalled) return;
  drmDetectionInstalled = true;
  try { patchRequestMediaKeySystemAccess(); } catch { /* ok */ }
  try { patchMediaElementSetMediaKeys(); } catch { /* ok */ }
  try { patchMediaKeySessionGenerateRequest(); } catch { /* ok */ }
  try { observeEncryptedMediaEvents(); } catch { /* ok */ }
}

function installDrmDetectionConfigListener(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as { source?: unknown; type?: unknown; enabled?: unknown } | null;
    if (!data || data.source !== POST_SOURCE || data.type !== DRM_CONFIG_TYPE) return;
    if (data.enabled === true) installDrmDetectionHooks();
  }, { passive: true });
}

// ---------------------------------------------------------------------------
// Patch window.fetch
// ---------------------------------------------------------------------------

function patchFetch(): void {
  const original = window.fetch;
  window.fetch = function patchedFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    let requestUrl: string | undefined;
    try {
      requestUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (isLikelyInterestingUrl(requestUrl)) emit(requestUrl, 'fetch');
    } catch {
      // Best-effort
    }
    return original.apply(this, [input, init] as Parameters<typeof fetch>).then((response) => {
      try {
        const responseUrl = response.url || requestUrl;
        const contentType = response.headers.get('content-type');
        if (responseUrl && isLikelyInterestingUrl(responseUrl, contentType)) {
          emit(responseUrl, 'fetch', contentType, response.headers.get('content-length'));
        }
      } catch {
        // Best-effort; never disturb page fetch semantics.
      }
      return response;
    });
  };
}

// ---------------------------------------------------------------------------
// Patch XMLHttpRequest
// ---------------------------------------------------------------------------

function patchXhr(): void {
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ): void {
    let resolved = '';
    try {
      resolved = url instanceof URL ? url.href : String(url);
      if (isLikelyInterestingUrl(resolved)) emit(resolved, 'xhr');
      let emittedResponse = false;
      this.addEventListener('readystatechange', () => {
        if (emittedResponse || this.readyState < 2) return;
        try {
          const contentType = this.getResponseHeader('content-type');
          const responseUrl = this.responseURL || resolved;
          if (isLikelyInterestingUrl(responseUrl, contentType)) {
            emittedResponse = true;
            emit(responseUrl, 'xhr', contentType, this.getResponseHeader('content-length'));
          }
        } catch {
          // Cross-origin response headers may be intentionally unavailable.
        }
      });
    } catch {
      // Best-effort
    }
    return originalOpen.apply(this, [method, url, async, username, password] as Parameters<
      typeof XMLHttpRequest.prototype.open
    >);
  };
}

// ---------------------------------------------------------------------------
// Observe HTMLMediaElement src changes
// ---------------------------------------------------------------------------

function observeMediaElement(node: HTMLMediaElement): void {
  if (observedMediaElements.has(node)) return;
  observedMediaElements.add(node);
  const initiator: Initiator = 'media-src';

  const checkSrc = (): void => {
    const src = node.currentSrc || node.src || node.getAttribute('src') || '';
    if (src) emit(src, initiator);
  };

  checkSrc();
  node.addEventListener('loadedmetadata', checkSrc, { passive: true });
  node.addEventListener('canplay', checkSrc, { passive: true });
  node.addEventListener('durationchange', checkSrc, { passive: true });

  const attrObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
        const src = node.getAttribute('src');
        if (src) emit(src, initiator);
      }
    }
  });
  attrObserver.observe(node, { attributes: true, attributeFilter: ['src'] });
}

function observeSourceElement(node: HTMLSourceElement): void {
  if (observedSourceElements.has(node)) return;
  observedSourceElements.add(node);
  const src = node.src || node.getAttribute('src') || '';
  if (src) emit(src, 'source-src');

  const attrObserver = new MutationObserver(() => {
    const s = node.src || node.getAttribute('src');
    if (s) emit(s, 'source-src');
  });
  attrObserver.observe(node, { attributes: true, attributeFilter: ['src'] });
}

// ---------------------------------------------------------------------------
// DOM observer — watch for new media elements
// ---------------------------------------------------------------------------

function scanMediaCandidates(root: typeof document | Element, maxElements: number): number {
  let scanned = 0;
  const visit = (element: Element): void => {
    if (scanned >= maxElements) return;
    scanned += 1;
    if (element instanceof HTMLVideoElement || element instanceof HTMLAudioElement) {
      observeMediaElement(element);
    } else if (element instanceof HTMLSourceElement) {
      observeSourceElement(element);
    }
  };

  if (root instanceof Element) visit(root);
  for (const el of root.querySelectorAll('video,audio,source')) {
    if (scanned >= maxElements) break;
    visit(el);
  }
  return scanned;
}

function observeDom(): void {
  if (!document.documentElement) return;
  scanMediaCandidates(document, MAX_INITIAL_MEDIA_ELEMENTS);

  const observer = new MutationObserver((mutations) => {
    let remaining = MAX_DOM_MUTATION_SCAN_ELEMENTS;
    for (const mutation of mutations) {
      if (remaining <= 0) break;
      for (const node of mutation.addedNodes) {
        if (remaining <= 0) break;
        if (!(node instanceof Element)) continue;
        remaining -= scanMediaCandidates(node, remaining);
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
}
// ---------------------------------------------------------------------------
// Player config sniffing (safe, read-only, no eval)
// ---------------------------------------------------------------------------

function sniffPlayerConfigs(): void {
  const sniff = (): void => {
    const visited = new WeakSet<object>();
    let objectCount = 0;
    let stringCount = 0;

    const tryEmitFromObject = (obj: unknown, depth = 0): void => {
      if (depth > MAX_CONFIG_DEPTH || !obj || typeof obj !== 'object') return;
      if (visited.has(obj)) return;
      if (objectCount >= MAX_CONFIG_OBJECTS || stringCount >= MAX_CONFIG_STRING_VALUES) return;
      visited.add(obj);
      objectCount += 1;

      const record = obj as Record<string, unknown>;
      let keysSeen = 0;
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        keysSeen += 1;
        if (keysSeen > MAX_CONFIG_KEYS_PER_OBJECT) break;
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !('value' in descriptor)) continue;
        const value = descriptor.value;
        if (typeof value === 'string') {
          stringCount += 1;
          if (isLikelyInterestingUrl(value) && isDownloadableUrl(value))
            emit(value, 'player-config');
          if (stringCount >= MAX_CONFIG_STRING_VALUES) return;
        } else if (typeof value === 'object' && value !== null) {
          tryEmitFromObject(value, depth + 1);
        }
        if (objectCount >= MAX_CONFIG_OBJECTS) return;
      }
    };

    const pageWindow = window as unknown as Record<string, unknown>;
    for (const key of ['INITIAL_STATE', '__NUXT__', '__NEXT_DATA__', 'ytInitialPlayerResponse']) {
      try {
        tryEmitFromObject(pageWindow[key]);
      } catch {
        // Page globals can be protected by accessors; ignore them.
      }
    }
  };

  document.addEventListener('DOMContentLoaded', sniff, { once: true, passive: true });
  window.addEventListener('load', sniff, { once: true, passive: true });
}
// ---------------------------------------------------------------------------
// Performance resource observer — catches late media requests missed by fetch/XHR
// ---------------------------------------------------------------------------

function observePerformanceResources(): void {
  const inspect = (entries: PerformanceEntry[]): void => {
    let inspected = 0;
    for (const entry of entries) {
      if (inspected >= MAX_PERFORMANCE_ENTRIES_PER_BATCH) break;
      inspected += 1;
      const url = entry.name;
      if (typeof url === 'string' && (isLikelyInterestingUrl(url) || isSmartStreamUrl(url))) {
        emit(url, 'performance-resource');
      }
    }
  };
  try {
    inspect(performance.getEntriesByType('resource').slice(-MAX_PERFORMANCE_ENTRIES_PER_BATCH));
  } catch {
    // Best-effort only.
  }
  try {
    const observer = new PerformanceObserver((list) => inspect(list.getEntries()));
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    try {
      const observer = new PerformanceObserver((list) => inspect(list.getEntries()));
      observer.observe({ entryTypes: ['resource'] });
    } catch {
      // PerformanceObserver may be disabled by the page or browser.
    }
  }
}
// ---------------------------------------------------------------------------
// MediaSource Extension (MSE) — detect video streams fed through SourceBuffer
// ---------------------------------------------------------------------------

function patchMediaSource(): void {
  const OriginalMediaSource = globalThis.MediaSource;
  if (!OriginalMediaSource || !OriginalMediaSource.prototype) return;
  const originalAddSourceBuffer = OriginalMediaSource.prototype.addSourceBuffer;
  if (typeof originalAddSourceBuffer !== 'function') return;
  OriginalMediaSource.prototype.addSourceBuffer = function patchedAddSourceBuffer(
    this: MediaSource,
    mimeType: string,
  ): SourceBuffer {
    try {
      if (mimeType) emit(mimeType, 'mediasource', mimeType);
    } catch { /* ignore */ }
    return originalAddSourceBuffer.apply(this, [mimeType]);
  };
}

// ---------------------------------------------------------------------------
// WebSocket — detect video stream URLs passed via WebSocket connections
// ---------------------------------------------------------------------------

function patchWebSocket(): void {
  const OriginalWebSocket = globalThis.WebSocket;
  if (!OriginalWebSocket) return;
  (globalThis as unknown as Record<string, unknown>).WebSocket = class PatchedWebSocket extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      try {
        const resolved = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
        if (isLikelyInterestingUrl(resolved)) emit(resolved, 'websocket');
      } catch { /* ignore */ }
      super(url, protocols);
    }
  } as typeof WebSocket;
}

// ---------------------------------------------------------------------------
// EventSource — detect video URLs pushed via Server-Sent Events
// ---------------------------------------------------------------------------

function patchEventSource(): void {
  const OriginalEventSource = globalThis.EventSource;
  if (!OriginalEventSource) return;
  (globalThis as unknown as Record<string, unknown>).EventSource = class PatchedEventSource extends OriginalEventSource {
    constructor(url: string | URL, eventSourceInitDict?: { withCredentials?: boolean }) {
      try {
        const resolved = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
        if (isLikelyInterestingUrl(resolved)) emit(resolved, 'eventsource');
      } catch { /* ignore */ }
      super(url, eventSourceInitDict);
    }
  } as typeof EventSource;
}

// ---------------------------------------------------------------------------
// URL.createObjectURL — detect blob URLs created for video/audio sources
// ---------------------------------------------------------------------------

function patchCreateObjectURL(): void {
  const original = URL.createObjectURL;
  if (typeof original !== 'function') return;
  URL.createObjectURL = function patchedCreateObjectURL(
    obj: Blob | MediaSource,
  ): string {
    try {
      if (obj instanceof Blob && obj.type) {
        emit(obj.type, 'blob-url', obj.type, String(obj.size));
      } else if (obj instanceof MediaSource) {
        emit('application/x-mediasource', 'blob-url', 'application/x-mediasource');
      }
    } catch { /* ignore */ }
    return original.call(this, obj);
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    try {
      installDrmDetectionConfigListener();
    } catch {
      /* ok */
    }
    try {
      patchFetch();
    } catch {
      /* ok */
    }
    try {
      patchXhr();
    } catch {
      /* ok */
    }
    try {
      observePerformanceResources();
    } catch {
      /* ok */
    }
    try {
      patchMediaSource();
    } catch {
      /* ok */
    }
    try {
      patchWebSocket();
    } catch {
      /* ok */
    }
    try {
      patchEventSource();
    } catch {
      /* ok */
    }
    try {
      patchCreateObjectURL();
    } catch {
      /* ok */
    }
    // Media element observation starts after the document is available
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', observeDom, { once: true, passive: true });
    } else {
      observeDom();
    }
    sniffPlayerConfigs();
  },
});
