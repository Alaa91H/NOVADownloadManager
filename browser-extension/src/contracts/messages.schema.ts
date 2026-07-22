import { z } from 'zod';
import { CandidateSchema } from './candidate.schema';
import { StreamQualitySchema } from './nova.protocol.v4';
import { SettingsSchema } from './settings.schema';
import { DrmIndicatorsSchema, DrmInfoSchema } from './drm.schema';
import { SiteRuleSchema } from '../rules/site-rules';
import { MAX_CANDIDATE_URL_CHARS, MAX_HANDOFF_CANDIDATES, MAX_SITE_RULES, MAX_TASK_ID_CHARS } from './limits';

export const SiteRulesImportSchema = z.array(SiteRuleSchema).max(MAX_SITE_RULES);

export const RuntimeMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('GET_BRIDGE_STATE') }),
  z.object({ type: z.literal('AUTO_CONNECT') }),
  z.object({ type: z.literal('RETRY_CONNECT') }),
  z.object({ type: z.literal('RESET_PAIRING') }),
  z.object({ type: z.literal('SCAN_PAGE'), tabId: z.number().int().positive().optional(), userActivated: z.boolean().default(false).optional() }),
  // OVERLAY_SCAN_PAGE is initiated by the in-page content-script button. It intentionally
  // carries NO tabId: the background binds the scan to the originating sender.tab.id so
  // a page can never request a scan of an arbitrary tab.
  z.object({ type: z.literal('OVERLAY_SCAN_PAGE') }),
  // OVERLAY_REFRESH_CANDIDATES is cache-only. It is used by the open picker to surface
  // late live captures (for example a newly selected video quality) without consuming
  // the heavier page-scan rate limit. It also carries no tabId and is bound to sender.tab.id.
  z.object({ type: z.literal('OVERLAY_REFRESH_CANDIDATES') }),
  // OVERLAY_SEND_SELECTED: chosen candidate ids from the in-page overlay picker (shown when
  // more than one candidate is captured). Same trust model as OVERLAY_SCAN_PAGE: content-script
  // only, bound to sender.tab.id. The background reads candidates from that tab's cache, so a
  // page can never hand off a candidate it did not actually capture.
  z.object({ type: z.literal('OVERLAY_SEND_SELECTED'), candidateIds: z.array(z.string().min(1).max(200)).min(1).max(MAX_HANDOFF_CANDIDATES) }),
  // Stream quality selector: resolve a manifest into concrete qualities via NOVA,
  // then send the user's chosen quality. UI-only messages (popup).
  z.object({
    type: z.literal('RESOLVE_STREAM'),
    manifestType: z.enum(['hls', 'dash']),
    url: z.string().url(),
    pageUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal('SEND_STREAM'),
    candidateId: z.string(),
    selectedQualityUrl: z.string().optional(),
    selectedQuality: StreamQualitySchema.optional(),
  }),
  z.object({
    type: z.literal('PROBE_YTDLP'),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal('DOWNLOAD_DIRECT'),
    url: z.string().url(),
    filename: z.string().optional(),
  }),
  // PAGE_TAP_CANDIDATES_FOUND is sent by page-tap-bridge (isolated content script) after
  // receiving, validating, and deduplicating postMessage events from page-tap-main (MAIN world).
  z.object({
    type: z.literal('PAGE_TAP_CANDIDATES_FOUND'),
    events: z.array(z.object({
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
    })).min(1).max(50),
  }),
  // PAGE_TAP_DRM_DETECTED is opt-in and information-only. It records that the
  // page requested encrypted-media playback, but never forwards license URLs,
  // request bodies, responses, keys, cookies, or Authorization headers.
  z.object({
    type: z.literal('PAGE_TAP_DRM_DETECTED'),
    events: z.array(z.object({
      pageUrl: z.string().min(1).max(MAX_CANDIDATE_URL_CHARS),
      detectedAt: z.number().int().nonnegative(),
      drm: DrmInfoSchema,
    })).min(1).max(20),
  }),
  z.object({
    type: z.literal('TAKEOVER_DOWNLOAD_CLICK'),
    url: z.string().min(1).max(MAX_CANDIDATE_URL_CHARS),
    pageUrl: z.string().min(1).max(MAX_CANDIDATE_URL_CHARS).optional(),
    download: z.string().max(240).optional(),
    referrer: z.string().max(MAX_CANDIDATE_URL_CHARS).optional(),
  }),
  z.object({ type: z.literal('CAPTURE_DOWNLOAD'), payload: z.object({
    url: z.string().min(1).max(2048),
    filename: z.string().max(240).optional(),
    referrer: z.string().max(2048).optional(),
    source: z.enum([
      'download-attribute', 'link-click', 'context-selection',
      'programmatic-click', 'window-open', 'dynamic-download-attr',
      'keyboard-enter', 'navigation-capture', 'floating-panel',
      // Emitted by the download-capture content script when it patches
      // location.assign/replace, form submits, and blob: anchor downloads.
      'location-assign', 'location-replace',
      'form-submit', 'form-submit-post',
      'blob-download', 'location-assign-blob', 'location-replace-blob',
    ]),
    tabId: z.number().int().optional(),
  }) }),
  z.object({ type: z.literal('CAPTURE_CONTEXT_MENU'), menuItemId: z.string(), pageUrl: z.string().optional(), linkUrl: z.string().optional(), srcUrl: z.string().optional(), selectionText: z.string().optional(), tabId: z.number().int().positive().optional() }),
  z.object({ type: z.literal('GET_CANDIDATES'), tabId: z.number().int().positive().optional() }),
  z.object({ type: z.literal('CLEAR_CANDIDATES'), tabId: z.number().int().positive().optional() }),
  z.object({ type: z.literal('SEND_CANDIDATE'), candidate: CandidateSchema }),
  z.object({ type: z.literal('SEND_BATCH'), candidates: z.array(CandidateSchema).min(1).max(MAX_HANDOFF_CANDIDATES) }),
  z.object({ type: z.literal('GET_OUTBOX_STATUS') }),
  z.object({ type: z.literal('RUN_OUTBOX_RETRY') }),
  z.object({ type: z.literal('GET_DIAGNOSTICS') }),
  z.object({ type: z.literal('GET_SETTINGS') }),
  z.object({ type: z.literal('UPDATE_SETTINGS'), settings: SettingsSchema.partial().passthrough() }),
  z.object({ type: z.literal('EXPORT_SETTINGS') }),
  z.object({ type: z.literal('IMPORT_SETTINGS'), settings: z.unknown() }),
  z.object({ type: z.literal('CLEAR_LOCAL_DATA'), scope: z.enum(['candidate-cache', 'diagnostics', 'outbox-terminal', 'all-local']).default('candidate-cache') }),
  z.object({ type: z.literal('GET_SITE_RULES') }),
  z.object({ type: z.literal('UPSERT_SITE_RULE'), rule: SiteRuleSchema }),
  z.object({ type: z.literal('DELETE_SITE_RULE'), id: z.string().min(1) }),
  z.object({ type: z.literal('IMPORT_SITE_RULES'), rules: z.unknown() }),
  z.object({ type: z.literal('EXPORT_SITE_RULES') }),
  z.object({ type: z.literal('REQUEST_PERMISSION'), permissions: z.array(z.string()).default([]), origins: z.array(z.string()).default([]) }),
  z.object({ type: z.literal('GET_PERMISSION_STATUS') }),
  z.object({ type: z.literal('PAUSE_TASK'), taskId: z.string().trim().min(1).max(MAX_TASK_ID_CHARS) }),
  z.object({ type: z.literal('RESUME_TASK'), taskId: z.string().trim().min(1).max(MAX_TASK_ID_CHARS) }),
  z.object({ type: z.literal('CANCEL_TASK'), taskId: z.string().trim().min(1).max(MAX_TASK_ID_CHARS) }),
  z.object({ type: z.literal('LIST_TASKS') }),
  z.object({
    type: z.literal('ANALYZE_MEDIA'),
    url: z.string().min(1).max(8192),
    context: z.object({
      pageUrl: z.string().optional(),
      referrer: z.string().optional(),
      title: z.string().optional(),
      mediaType: z.string().optional(),
    }).optional(),
  }),
  z.object({ type: z.literal('OPEN_NOVA') }),
  z.object({ type: z.literal('WAKE_UP_DESKTOP') }),
]);

export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;

export const ContentLinkSnapshotSchema = z.object({
  url: z.string(),
  tag: z.enum(['a', 'video', 'audio', 'source', 'img', 'iframe', 'embed', 'object', 'track', 'meta', 'script', 'unknown']).default('unknown'),
  attr: z.string().optional(),
  text: z.string().optional(),
  download: z.string().optional(),
  rel: z.string().optional(),
  type: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  media: z.string().optional(),
});
export type ContentLinkSnapshot = z.infer<typeof ContentLinkSnapshotSchema>;

export const ContentMediaSnapshotSchema = z.object({
  url: z.string(),
  kind: z.enum(['video', 'audio', 'image']),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  poster: z.string().optional(),
});
export type ContentMediaSnapshot = z.infer<typeof ContentMediaSnapshotSchema>;

export type DrmIndicators = z.infer<typeof DrmIndicatorsSchema>;

export const ContentScanResponseSchema = z.object({
  url: z.string(),
  baseUrl: z.string().optional(),
  title: z.string().optional(),
  html: z.string().default(''),
  links: z.array(ContentLinkSnapshotSchema).default([]),
  media: z.array(ContentMediaSnapshotSchema).default([]),
  openGraph: z.array(ContentLinkSnapshotSchema).default([]),
  jsonLd: z.array(z.unknown()).default([]),
  capturedAt: z.string().optional(),
  drmIndicators: DrmIndicatorsSchema.optional(),
});
export type ContentScanResponse = z.infer<typeof ContentScanResponseSchema>;
