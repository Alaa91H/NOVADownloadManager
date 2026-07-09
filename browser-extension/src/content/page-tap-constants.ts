export const POST_SOURCE = 'nova-page-tap-v1';
export const POST_TYPE = 'NOVA_PAGE_TAP_CANDIDATE';
export const DRM_CONFIG_TYPE = 'NOVA_DRM_DETECTION_CONFIG';
export const DRM_POST_TYPE = 'NOVA_DRM_DETECTION';
export const POST_VERSION = 1;

export const MEDIA_EXTENSIONS = new Set([
  'm3u8',
  'mpd',
  'mp4',
  'm4v',
  'webm',
  'mkv',
  'mov',
  'avi',
  'flv',
  '3gp',
  '3g2',
  'ts',
  'm2ts',
  'mpeg',
  'mpg',
  'ogv',
  'mp3',
  'm4a',
  'aac',
  'flac',
  'wav',
  'ogg',
  'opus',
  'wma',
  'aiff',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'zst',
  'cab',
  'pdf',
  'epub',
  'mobi',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'exe',
  'msi',
  'dmg',
  'pkg',
  'appimage',
  'deb',
  'rpm',
  'iso',
  'img',
  'apk',
  'xapk',
  'crx',
  'torrent',
]);

export const TORRENT_MAGNET_RE = /^magnet:\?xt=urn:btih/i;
export const SMART_STREAM_URL_RE =
  /(?:\.m3u8|\.mpd|\.mp4|\.m4v|\.webm|\.mkv|\.mov)(?:[?#]|$)|\/videoplayback\b|mime=(?:video|audio)(?:%2[fF]|\/)|type=(?:video|audio)/i;

export const STREAM_URL_FAST_RE =
  /(?:\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|avi|flv|3gp|3g2|ts|m2ts|mpeg|mpg|ogv|mp3|m4a|aac|flac|wav|ogg|opus|wma|aiff|zip|rar|7z|tar|gz|bz2|xz|zst|cab|pdf|epub|mobi|docx?|xlsx?|pptx?|exe|msi|dmg|pkg|appimage|deb|rpm|iso|img|apk|xapk|crx|torrent)(?:[?#]|$)|\/videoplayback\b|mime=(?:video|audio)(?:%2[fF]|\/)|type=(?:video|audio)|magnet:\?xt=urn:btih)/i;
export const MAX_EMIT_URL_CHARS = 8192;
export const EMIT_DEDUPE_TTL_MS = 10_000;
export const EMIT_DEDUPE_MAX = 600;
export const MAX_EMITS_PER_MINUTE = 240;
export const MAX_PERFORMANCE_ENTRIES_PER_BATCH = 120;
export const MAX_INITIAL_MEDIA_ELEMENTS = 250;
export const MAX_DOM_MUTATION_SCAN_ELEMENTS = 120;
export const MAX_CONFIG_DEPTH = 3;
export const MAX_CONFIG_OBJECTS = 80;
export const MAX_CONFIG_KEYS_PER_OBJECT = 80;
export const MAX_CONFIG_STRING_VALUES = 400;

export type MediaHint =
  | 'video'
  | 'audio'
  | 'image'
  | 'document'
  | 'archive'
  | 'torrent'
  | 'manifest'
  | 'other';
export type Initiator =
  | 'fetch'
  | 'xhr'
  | 'media-src'
  | 'source-src'
  | 'player-config'
  | 'performance-resource'
  | 'mediasource'
  | 'websocket'
  | 'eventsource'
  | 'blob-url';

export type StreamMetadata = {
  mimeHint?: string;
  extensionHint?: string;
  mediaHint?: MediaHint;
  sizeBytes?: number;
  width?: number;
  height?: number;
  bitrate?: number;
  durationSec?: number;
  qualityLabel?: string;
  itag?: string;
};

export type DrmSystem = 'widevine' | 'playready' | 'fairplay' | 'clearkey' | 'unknown';
export type DrmSource = 'eme' | 'encrypted-event';
export type DrmDetectionPayload = {
  keySystem?: string;
  system?: DrmSystem;
  source: DrmSource;
  initDataType?: string;
  reason: string;
};

export const YOUTUBE_ITAG_QUALITY: Record<string, Partial<StreamMetadata>> = {
  '5': { extensionHint: 'flv', mediaHint: 'video', width: 320, height: 240, qualityLabel: '240p' },
  '17': { extensionHint: '3gp', mediaHint: 'video', width: 176, height: 144, qualityLabel: '144p' },
  '18': { extensionHint: 'mp4', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p' },
  '22': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 1280,
    height: 720,
    qualityLabel: '720p',
  },
  '34': { extensionHint: 'flv', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p' },
  '35': { extensionHint: 'flv', mediaHint: 'video', width: 854, height: 480, qualityLabel: '480p' },
  '36': { extensionHint: '3gp', mediaHint: 'video', width: 320, height: 240, qualityLabel: '240p' },
  '37': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 1920,
    height: 1080,
    qualityLabel: '1080p',
  },
  '38': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 4096,
    height: 3072,
    qualityLabel: '3072p',
  },
  '43': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 640,
    height: 360,
    qualityLabel: '360p',
  },
  '44': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 854,
    height: 480,
    qualityLabel: '480p',
  },
  '45': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 1280,
    height: 720,
    qualityLabel: '720p',
  },
  '46': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 1920,
    height: 1080,
    qualityLabel: '1080p',
  },
  '133': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 426,
    height: 240,
    qualityLabel: '240p',
  },
  '134': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 640,
    height: 360,
    qualityLabel: '360p',
  },
  '135': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 854,
    height: 480,
    qualityLabel: '480p',
  },
  '136': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 1280,
    height: 720,
    qualityLabel: '720p',
  },
  '137': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 1920,
    height: 1080,
    qualityLabel: '1080p',
  },
  '160': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 256,
    height: 144,
    qualityLabel: '144p',
  },
  '242': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 426,
    height: 240,
    qualityLabel: '240p',
  },
  '243': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 640,
    height: 360,
    qualityLabel: '360p',
  },
  '244': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 854,
    height: 480,
    qualityLabel: '480p',
  },
  '247': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 1280,
    height: 720,
    qualityLabel: '720p',
  },
  '248': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 1920,
    height: 1080,
    qualityLabel: '1080p',
  },
  '264': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 2560,
    height: 1440,
    qualityLabel: '1440p',
  },
  '266': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 3840,
    height: 2160,
    qualityLabel: '2160p',
  },
  '271': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 2560,
    height: 1440,
    qualityLabel: '1440p',
  },
  '272': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 3840,
    height: 2160,
    qualityLabel: '2160p',
  },
  '278': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 256,
    height: 144,
    qualityLabel: '144p',
  },
  '298': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 1280,
    height: 720,
    qualityLabel: '720p60',
  },
  '299': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 1920,
    height: 1080,
    qualityLabel: '1080p60',
  },
  '302': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 1280,
    height: 720,
    qualityLabel: '720p60',
  },
  '303': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 1920,
    height: 1080,
    qualityLabel: '1080p60',
  },
  '308': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 2560,
    height: 1440,
    qualityLabel: '1440p60',
  },
  '313': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 3840,
    height: 2160,
    qualityLabel: '2160p',
  },
  '315': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 3840,
    height: 2160,
    qualityLabel: '2160p60',
  },
  '330': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 256,
    height: 144,
    qualityLabel: '144p60',
  },
  '331': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 426,
    height: 240,
    qualityLabel: '240p60',
  },
  '332': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 640,
    height: 360,
    qualityLabel: '360p60',
  },
  '333': {
    extensionHint: 'webm',
    mediaHint: 'video',
    width: 854,
    height: 480,
    qualityLabel: '480p60',
  },
  '394': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 256,
    height: 144,
    qualityLabel: '144p',
  },
  '395': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 426,
    height: 240,
    qualityLabel: '240p',
  },
  '396': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 640,
    height: 360,
    qualityLabel: '360p',
  },
  '397': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 854,
    height: 480,
    qualityLabel: '480p',
  },
  '398': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 1280,
    height: 720,
    qualityLabel: '720p',
  },
  '399': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 1920,
    height: 1080,
    qualityLabel: '1080p',
  },
  '400': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 2560,
    height: 1440,
    qualityLabel: '1440p',
  },
  '401': {
    extensionHint: 'mp4',
    mediaHint: 'video',
    width: 3840,
    height: 2160,
    qualityLabel: '2160p',
  },
  '139': { extensionHint: 'm4a', mediaHint: 'audio', qualityLabel: 'audio' },
  '140': { extensionHint: 'm4a', mediaHint: 'audio', qualityLabel: 'audio' },
  '141': { extensionHint: 'm4a', mediaHint: 'audio', qualityLabel: 'audio' },
  '171': { extensionHint: 'webm', mediaHint: 'audio', qualityLabel: 'audio' },
  '249': { extensionHint: 'webm', mediaHint: 'audio', qualityLabel: 'audio' },
  '250': { extensionHint: 'webm', mediaHint: 'audio', qualityLabel: 'audio' },
  '251': { extensionHint: 'webm', mediaHint: 'audio', qualityLabel: 'audio' },
};
