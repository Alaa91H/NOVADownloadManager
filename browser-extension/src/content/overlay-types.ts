import type { OverlaySettings } from '../contracts/settings.schema';

type LinkTag =
  | 'a'
  | 'video'
  | 'audio'
  | 'source'
  | 'img'
  | 'iframe'
  | 'embed'
  | 'object'
  | 'track'
  | 'meta'
  | 'script'
  | 'unknown';

type OverlayMediaType = OverlaySettings['mediaTypes'][number];

type OverlayCandidate = {
  id: string;
  url: string;
  pageUrl?: string;
  filename?: string;
  extension?: string;
  mimeType?: string;
  mediaType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  bitrate?: number;
  durationSec?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
};

type SavedOverlayPosition = {
  left: number;
  top: number;
  viewportWidth?: number;
  viewportHeight?: number;
  updatedAt?: string;
};

type OverlayPlacement = 'up' | 'down' | 'left' | 'right';
type OverlayAlignment = 'start' | 'center' | 'end';

const VIDEO_OVERLAY_HOST_ID = 'adm-video-download-overlay-host';
const PICKER_HOST_ID = 'adm-candidate-picker-host';
const VIDEO_OVERLAY_RELAY_DATASET = 'admVideoOverlayRelayInstalled';
const VIDEO_OVERLAY_DISCOVERY_SOURCE = 'adm-extension-video-overlay';
const VIDEO_OVERLAY_DISCOVERY_TYPE = 'video-candidate-detected';
const VIDEO_OVERLAY_LIVE_REFRESH_EVENT = 'adm-video-overlay-live-refresh';
const CANDIDATE_CACHE_UPDATED_MESSAGE_TYPE = 'ADM_CANDIDATE_CACHE_UPDATED';
const OVERLAY_SCAN_MESSAGE_TYPE = 'OVERLAY_SCAN_PAGE';
const OVERLAY_REFRESH_MESSAGE_TYPE = 'OVERLAY_REFRESH_CANDIDATES';
const CANDIDATE_CACHE_STORAGE_PREFIX = 'adm.candidateCache.';
const VIDEO_OVERLAY_POSITION_STORAGE_KEY = 'adm.videoOverlayPosition.v1';
const DOWNLOAD_OVERLAY_POSITION_STORAGE_PREFIX = 'adm.downloadOverlayPosition.v2';
const VIDEO_OVERLAY_DESTROY_EVENT = 'adm-video-overlay-destroy';
const VIDEO_OVERLAY_USER_CLOSE_EVENT = 'adm-video-overlay-close';
const PICKER_DESTROY_EVENT = 'adm-candidate-picker-destroy';
const SETTINGS_STORAGE_KEY = 'adm.settings';
const OVERLAY_DIAGNOSTICS_STORAGE_KEY = 'adm.downloadOverlayDiagnostics.v1';
const OVERLAY_EDGE_MARGIN = 18;
const MAX_OVERLAY_HINT_VIDEO_ELEMENTS = 80;
const MAX_OVERLAY_HINT_SOURCE_ELEMENTS = 16;
const MAX_OVERLAY_HINT_ELEMENTS = 500;
const PICKER_LIVE_BURST_MS = 12_000;
const PICKER_MAX_CONTINUOUS_REFRESH_ROUNDS = 16;
const PICKER_STEADY_REFRESH_MIN_MS = 5_000;

const SMART_VIDEO_OVERLAY_MEDIA_TYPES = new Set<OverlayMediaType>(['video', 'manifest']);

const SMART_VIDEO_URL_HINT_RE =
  /(?:\.m3u8|\.mpd|\.mp4|\.m4v|\.webm|\.mkv|\.mov|\.avi|\.flv|\.ts|\.m2ts)(?:[?#]|$)|\/videoplayback\b|mime=video%2f|mime=video\/|type=video|\/(?:hls|dash)\/|\.m3u8\?|\.mpd\?|segment-\d+\.ts|chunk-\w+\./i;

const NOISE_DOMAIN_PATTERNS =
  /(?:doubleclick|googlesyndication|googleadservices|amazon-adsystem|adnxs|rubiconproject|casalemedia|adsrv|adserver|adservice|facebook\.com\/tr|pixel\.facebook|analytics\.twitter|google-analytics|googletagmanager|gtm\.js|hotjar|mouseflow|fullstory|newrelic|datadog|sentry\.io|raygun|stackpath|bootstrapcdn|cDN\.jsdelivr|googleapis\.com\/css|googleapis\.com\/js|fonts\.gstatic|gravatar|pixel\b|beacon\b|favicon\.ico)/i;

const VIDEO_LINK_SELECTOR = [
  'video',
  'source[src][type^="video/"]',
  'source[src][type^="application/vnd.apple.mpegurl"]',
  'source[src][type^="application/dash+xml"]',
  '[data-video]',
  '[data-video-src]',
  '[data-video-url]',
  '[data-mp4]',
  '[data-hls]',
  '[data-hls-url]',
  '[data-m3u8]',
  '[data-m3u8-url]',
  '[data-dash]',
  '[data-mpd]',
  '[data-mpd-url]',
  '[data-dash-url]',
  '[data-master]',
  '[data-manifest]',
  '[data-stream]',
  '[data-stream-url]',
  '[data-source]',
  '[data-media]',
  '[data-media-url]',
  '[data-content]',
  '[data-file]',
  '[data-file-url]',
  'meta[property="og:video"]',
  'meta[property="og:video:url"]',
  'meta[property="og:video:secure_url"]',
  'meta[property="og:video:type"]',
  'meta[name="twitter:player"]',
  'meta[name="twitter:player:stream"]',
  'meta[itemprop="contentUrl"]',
  'meta[itemprop="embedUrl"]',
  'link[rel="alternate"][type^="video/"]',
  'link[rel="alternate"][href*=".m3u8"]',
  'link[rel="alternate"][href*=".mpd"]',
  'audio',
  'img[src]',
  'img[srcset]',
  'a[href*=".mp4"]',
  'a[href*=".webm"]',
  'a[href*=".mkv"]',
  'a[href*=".mov"]',
  'a[href*=".m3u8"]',
  'a[href*=".mpd"]',
  'a[href*=".avi"]',
  'a[href*=".flv"]',
  'a[href*=".ts"]',
  'a[href*=".m2ts"]',
  'a[href*="mp4"]',
  'a[href*="video"]',
  'a[href*="stream"]',
  'a[href*="media"]',
  'a[href*="download"]',
  'a[href*=".mp3"]',
  'a[href*=".flac"]',
  'a[href*=".m4a"]',
  'a[href*=".aac"]',
  'link[rel="preload"][as="video"]',
  'link[rel="prefetch"][as="video"]',
  'link[as="video"][href]',
  'a[href*=".ogg"]',
  'a[href*=".wav"]',
  'a[href*=".zip"]',
  'a[href*=".rar"]',
  'a[href*=".7z"]',
  'a[href*=".tar"]',
  'a[href*=".gz"]',
  'a[href*=".pdf"]',
  'a[href*=".epub"]',
  'a[href*=".exe"]',
  'a[href*=".msi"]',
  'a[href*=".dmg"]',
  'a[href*=".apk"]',
  'a[href*=".torrent"]',
  'a[href^="magnet:?"]',
].join(',');

const EMBEDDED_ATTR_MEDIA_RE =
  /(?:https?:)?\\?\/\\?\/[^"'<>\s]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|avi|flv|mp3|m4a|aac|flac|wav|ogg|opus|zip|rar|7z|tar|gz|bz2|xz|exe|msi|dmg|pkg|appimage|deb|rpm|iso|img|apk|xapk|pdf|epub|mobi|doc|docx|xls|xlsx|ppt|pptx|torrent)(?:[?#][^"'<>\s]*)?|(?:\.{0,2}\/|\/)[^"'<>\s]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|avi|flv|mp3|m4a|aac|flac|wav|ogg|opus|zip|rar|7z|tar|gz|bz2|xz|exe|msi|dmg|pkg|appimage|deb|rpm|iso|img|apk|xapk|pdf|epub|mobi|doc|docx|xls|xlsx|ppt|pptx|torrent)(?:[?#][^"'<>\s]*)?/gi;

const OVERLAY_MEDIA_TYPE_BY_EXTENSION: Record<string, OverlayMediaType> = {
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  mkv: 'video',
  mov: 'video',
  avi: 'video',
  flv: 'video',
  m3u8: 'manifest',
  mpd: 'manifest',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  wav: 'audio',
  ogg: 'audio',
  opus: 'audio',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  gif: 'image',
  svg: 'image',
  avif: 'image',
  pdf: 'document',
  epub: 'document',
  mobi: 'document',
  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  ppt: 'document',
  pptx: 'document',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  exe: 'app',
  msi: 'app',
  dmg: 'app',
  pkg: 'app',
  appimage: 'app',
  deb: 'app',
  rpm: 'app',
  apk: 'app',
  xapk: 'app',
  iso: 'app',
  img: 'app',
  torrent: 'torrent',
};

export type {
  LinkTag,
  OverlayMediaType,
  OverlayCandidate,
  SavedOverlayPosition,
  OverlayPlacement,
  OverlayAlignment,
};

export {
  VIDEO_OVERLAY_HOST_ID,
  PICKER_HOST_ID,
  VIDEO_OVERLAY_RELAY_DATASET,
  VIDEO_OVERLAY_DISCOVERY_SOURCE,
  VIDEO_OVERLAY_DISCOVERY_TYPE,
  VIDEO_OVERLAY_LIVE_REFRESH_EVENT,
  CANDIDATE_CACHE_UPDATED_MESSAGE_TYPE,
  OVERLAY_SCAN_MESSAGE_TYPE,
  OVERLAY_REFRESH_MESSAGE_TYPE,
  CANDIDATE_CACHE_STORAGE_PREFIX,
  VIDEO_OVERLAY_POSITION_STORAGE_KEY,
  DOWNLOAD_OVERLAY_POSITION_STORAGE_PREFIX,
  VIDEO_OVERLAY_DESTROY_EVENT,
  VIDEO_OVERLAY_USER_CLOSE_EVENT,
  PICKER_DESTROY_EVENT,
  SETTINGS_STORAGE_KEY,
  OVERLAY_DIAGNOSTICS_STORAGE_KEY,
  OVERLAY_EDGE_MARGIN,
  MAX_OVERLAY_HINT_VIDEO_ELEMENTS,
  MAX_OVERLAY_HINT_SOURCE_ELEMENTS,
  MAX_OVERLAY_HINT_ELEMENTS,
  PICKER_LIVE_BURST_MS,
  PICKER_MAX_CONTINUOUS_REFRESH_ROUNDS,
  PICKER_STEADY_REFRESH_MIN_MS,
  SMART_VIDEO_OVERLAY_MEDIA_TYPES,
  SMART_VIDEO_URL_HINT_RE,
  NOISE_DOMAIN_PATTERNS,
  VIDEO_LINK_SELECTOR,
  EMBEDDED_ATTR_MEDIA_RE,
  OVERLAY_MEDIA_TYPE_BY_EXTENSION,
};
