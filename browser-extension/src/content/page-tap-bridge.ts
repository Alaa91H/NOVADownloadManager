/**
 * page-tap-bridge — Phase 3.
 *
 * Isolated content-script (ISOLATED world). Receives postMessage events from
 * page-tap-main (MAIN world), validates them with Zod, deduplicates, normalises
 * the URL, filters dangerous schemes, then forwards to the background via
 * runtime.sendMessage (PAGE_TAP_CANDIDATES_FOUND).
 *
 * SECURITY CONTRACT:
 *  - Only accepts messages with source === 'nova-page-tap-v1'.
 *  - Validates every message through Zod before acting.
 *  - Never forwards cookies, Authorization, or request body.
 *  - Blocks blob:, data:, javascript:, file: schemes.
 *  - Deduplicates within a 30-second window.
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import browser from 'webextension-polyfill';
import { z } from 'zod';
import { MAX_CANDIDATE_URL_CHARS } from '../contracts/limits';
// ---------------------------------------------------------------------------
// Schema (mirrors page-tap-main constants)
// ---------------------------------------------------------------------------

const PAGE_TAP_SOURCE = 'nova-page-tap-v1';
const PageTapEventSchema = z.object({
  source: z.literal(PAGE_TAP_SOURCE),
  type: z.literal('NOVA_PAGE_TAP_CANDIDATE'),
  version: z.literal(1),
  url: z.string().min(1).max(MAX_CANDIDATE_URL_CHARS),
  pageUrl: z.string().min(1).max(MAX_CANDIDATE_URL_CHARS),
  initiator: z.enum(['fetch', 'xhr', 'media-src', 'source-src', 'player-config', 'performance-resource', 'mediasource', 'websocket', 'eventsource', 'blob-url']),
  detectedAt: z.number().int().nonnegative(),
  mimeHint: z.string().max(128).optional(),
  extensionHint: z.string().max(20).optional(),
  mediaHint: z.enum(['video', 'audio', 'image', 'document', 'archive', 'torrent', 'manifest', 'other']).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bitrate: z.number().int().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  qualityLabel: z.string().max(64).optional(),
  itag: z.string().max(16).optional(),
});

type PageTapEvent = z.infer<typeof PageTapEventSchema>;

// ---------------------------------------------------------------------------
// Dedupe cache — keyed by URL, expires after 30 seconds
// ---------------------------------------------------------------------------

const DEDUPE_TTL_MS = 30_000;
const dedupeCache = new Map<string, number>();

function isDuplicate(url: string, now: number): boolean {
  const last = dedupeCache.get(url);
  if (last !== undefined && now - last < DEDUPE_TTL_MS) return true;
  dedupeCache.set(url, now);
  // Cleanup stale entries periodically (keep map small)
  if (dedupeCache.size > 200) {
    for (const [k, v] of dedupeCache) {
      if (now - v > DEDUPE_TTL_MS) dedupeCache.delete(k);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// URL safety check
// ---------------------------------------------------------------------------

const BLOCKED_SCHEMES = new Set(['blob:', 'data:', 'javascript:', 'about:', 'file:']);

function isSafeUrl(url: string): boolean {
  // Allow magnet links
  if (/^magnet:\?xt=urn:btih/i.test(url)) return true;
  try {
    const scheme = new URL(url).protocol;
    if (BLOCKED_SCHEMES.has(scheme.toLowerCase())) return false;
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Normalise URL — strip fragment; leave signed query params intact
// ---------------------------------------------------------------------------

function normalizeUrl(raw: string): string {
  if (/^magnet:/i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    u.hash = '';
    return u.toString();
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Background message
// ---------------------------------------------------------------------------

function forwardToBackground(events: PageTapEvent[]): void {
  browser.runtime.sendMessage({ type: 'PAGE_TAP_CANDIDATES_FOUND', events }).catch(() => {
    // Background service worker may be sleeping; best-effort.
  });
}

// ---------------------------------------------------------------------------
// Batch sending (debounced 150 ms to avoid per-URL bursts)
// ---------------------------------------------------------------------------

let batch: PageTapEvent[] = [];
let batchTimer: ReturnType<typeof setTimeout> | undefined;
const BATCH_DEBOUNCE_MS = 150;

function scheduleFlush(): void {
  if (batchTimer !== undefined) return;
  batchTimer = setTimeout(() => {
    batchTimer = undefined;
    if (batch.length === 0) return;
    const toSend = batch.splice(0);
    forwardToBackground(toSend);
  }, BATCH_DEBOUNCE_MS);
}

function enqueue(event: PageTapEvent): void {
  batch.push(event);
  scheduleFlush();
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

function handleMessage(event: MessageEvent): void {
  // Only accept same-window messages from the page world
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.source !== PAGE_TAP_SOURCE) return;

  const parsed = PageTapEventSchema.safeParse(data);
  if (!parsed.success) return;

  const tap = parsed.data;
  const normalised = normalizeUrl(tap.url);

  if (!isSafeUrl(normalised)) return;
  if (isDuplicate(normalised, tap.detectedAt)) return;

  enqueue({ ...tap, url: normalised });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'ISOLATED',
  runAt: 'document_start',
  main() {
    window.addEventListener('message', handleMessage, { passive: true });
  },
});
