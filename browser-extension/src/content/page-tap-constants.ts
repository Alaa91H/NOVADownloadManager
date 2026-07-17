export const POST_SOURCE = 'nova-page-tap-v1';
export const POST_TYPE = 'NOVA_PAGE_TAP_CANDIDATE';
export const DRM_CONFIG_TYPE = 'NOVA_DRM_DETECTION_CONFIG';
export const DRM_POST_TYPE = 'NOVA_DRM_DETECTION';
export const POST_VERSION = 1;

export const MEDIA_EXTENSIONS = new Set([
  // Video
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'wmv', 'vob', 'ogv', 'ogm',
  '3gp', '3g2', 'ts', 'm2ts', 'mts', 'm4p', 'mpeg', 'mpg', 'divx', 'f4v', 'rm', 'rmvb', 'asf', 'vob',
  // Audio
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'ape', 'alac', 'mid', 'midi',
  // Image
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'ico', 'raw', 'cr2', 'nef', 'arw',
  // Manifest
  'm3u8', 'm3u', 'mpd',
  // Archive
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'cab', 'iso', 'img', 'dmg',
  // Document
  'pdf', 'epub', 'mobi', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'rtf', 'odt', 'ods', 'odp',
  // App
  'exe', 'msi', 'dmg', 'pkg', 'appimage', 'deb', 'rpm', 'apk', 'xapk', 'crx', 'app', 'msix',
  // Torrent
  'torrent', 'magnet',
  // Subtitle
  'srt', 'ass', 'ssa', 'vtt', 'sub', 'idx',
]);

export const TORRENT_MAGNET_RE = /^magnet:\?xt=urn:btih/i;
export const SMART_STREAM_URL_RE =
  /(?:\.m3u8|\.m3u|\.mpd|\.mp4|\.m4v|\.webm|\.mkv|\.mov|\.avi|\.flv|\.wmv|\.ts|\.m2ts|\.ogg|\.opus)(?:[?#]|$)|\/videoplayback\b|\/manifest\(|\/master\.m3u8|mime=(?:video|audio)(?:%2[fF]|\/)|type=(?:video|audio)|googlevideo\.com|cdn\.|\.akamaized\.net|\.cloudfront\./i;

export const STREAM_URL_FAST_RE =
  /(?:\.(?:m3u8|m3u|mpd|mp4|m4v|webm|mkv|mov|avi|flv|wmv|3gp|3g2|ts|m2ts|mts|mpeg|mpg|ogv|mp3|m4a|aac|flac|wav|ogg|opus|wma|aiff|ape|alac|zip|rar|7z|tar|gz|bz2|xz|zst|cab|iso|img|dmg|pdf|epub|mobi|docx?|xlsx?|pptx?|csv|rtf|exe|msi|dmg|pkg|appimage|deb|rpm|apk|xapk|crx|torrent|srt|ass|vtt)(?:[?#]|$)|\/videoplayback\b|\/manifest\(|\/master\.m3u8|mime=(?:video|audio)(?:%2[fF]|\/)|type=(?:video|audio)|googlevideo\.com|cdn\.|\.akamaized\.net|\.cloudfront\.|magnet:\?xt=urn:btih)/i;

export const MAX_EMIT_URL_CHARS = 8192;
export const EMIT_DEDUPE_TTL_MS = 10_000;
export const EMIT_DEDUPE_MAX = 600;
export const MAX_EMITS_PER_MINUTE = 480;
export const MAX_PERFORMANCE_ENTRIES_PER_BATCH = 200;
export const MAX_INITIAL_MEDIA_ELEMENTS = 500;
export const MAX_DOM_MUTATION_SCAN_ELEMENTS = 200;
export const MAX_CONFIG_DEPTH = 5;
export const MAX_CONFIG_OBJECTS = 150;
export const MAX_CONFIG_KEYS_PER_OBJECT = 120;
export const MAX_CONFIG_STRING_VALUES = 800;

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
  '6': { extensionHint: 'flv', mediaHint: 'video', width: 320, height: 240, qualityLabel: '240p' },
  '13': { extensionHint: '3gp', mediaHint: 'video', width: 176, height: 144, qualityLabel: '144p' },
  '17': { extensionHint: '3gp', mediaHint: 'video', width: 176, height: 144, qualityLabel: '144p' },
  '18': { extensionHint: 'mp4', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p' },
  '22': { extensionHint: 'mp4', mediaHint: 'video', width: 1280, height: 720, qualityLabel: '720p' },
  '34': { extensionHint: 'flv', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p' },
  '35': { extensionHint: 'flv', mediaHint: 'video', width: 854, height: 480, qualityLabel: '480p' },
  '36': { extensionHint: '3gp', mediaHint: 'video', width: 320, height: 240, qualityLabel: '240p' },
  '37': { extensionHint: 'mp4', mediaHint: 'video', width: 1920, height: 1080, qualityLabel: '1080p' },
  '38': { extensionHint: 'mp4', mediaHint: 'video', width: 4096, height: 3072, qualityLabel: '3072p' },
  '43': { extensionHint: 'webm', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p' },
  '44': { extensionHint: 'webm', mediaHint: 'video', width: 854, height: 480, qualityLabel: '480p' },
  '45': { extensionHint: 'webm', mediaHint: 'video', width: 1280, height: 720, qualityLabel: '720p' },
  '46': { extensionHint: 'webm', mediaHint: 'video', width: 1920, height: 1080, qualityLabel: '1080p' },
  '82': { extensionHint: 'mp4', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p' },
  '83': { extensionHint: 'mp4', mediaHint: 'video', width: 854, height: 480, qualityLabel: '480p' },
  '84': { extensionHint: 'mp4', mediaHint: 'video', width: 1280, height: 720, qualityLabel: '720p' },
  '85': { extensionHint: 'mp4', mediaHint: 'video', width: 1920, height: 1080, qualityLabel: '1080p' },
  '100': { extensionHint: 'webm', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p' },
  '101': { extensionHint: 'webm', mediaHint: 'video', width: 854, height: 480, qualityLabel: '480p' },
  '102': { extensionHint: 'webm', mediaHint: 'video', width: 1280, height: 720, qualityLabel: '720p' },
  '132': { extensionHint: 'mp4', mediaHint: 'video', width: 320, height: 240, qualityLabel: '240p' },
  '133': { extensionHint: 'mp4', mediaHint: 'video', width: 426, height: 240, qualityLabel: '240p' },
  '134': { extensionHint: 'mp4', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p' },
  '135': { extensionHint: 'mp4', mediaHint: 'video', width: 854, height: 480, qualityLabel: '480p' },
  '136': { extensionHint: 'mp4', mediaHint: 'video', width: 1280, height: 720, qualityLabel: '720p' },
  '137': { extensionHint: 'mp4', mediaHint: 'video', width: 1920, height: 1080, qualityLabel: '1080p' },
  '160': { extensionHint: 'mp4', mediaHint: 'video', width: 256, height: 144, qualityLabel: '144p' },
  '212': { extensionHint: 'mp4', mediaHint: 'video', width: 426, height: 240, qualityLabel: '240p' },
  '218': { extensionHint: 'webm', mediaHint: 'video', width: 854, height: 480, qualityLabel: '480p' },
  '219': { extensionHint: 'webm', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p' },
  '242': { extensionHint: 'webm', mediaHint: 'video', width: 426, height: 240, qualityLabel: '240p' },
  '243': { extensionHint: 'webm', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p' },
  '244': { extensionHint: 'webm', mediaHint: 'video', width: 854, height: 480, qualityLabel: '480p' },
  '247': { extensionHint: 'webm', mediaHint: 'video', width: 1280, height: 720, qualityLabel: '720p' },
  '248': { extensionHint: 'webm', mediaHint: 'video', width: 1920, height: 1080, qualityLabel: '1080p' },
  '264': { extensionHint: 'mp4', mediaHint: 'video', width: 2560, height: 1440, qualityLabel: '1440p' },
  '266': { extensionHint: 'mp4', mediaHint: 'video', width: 3840, height: 2160, qualityLabel: '2160p' },
  '271': { extensionHint: 'webm', mediaHint: 'video', width: 2560, height: 1440, qualityLabel: '1440p' },
  '272': { extensionHint: 'webm', mediaHint: 'video', width: 3840, height: 2160, qualityLabel: '2160p' },
  '278': { extensionHint: 'webm', mediaHint: 'video', width: 256, height: 144, qualityLabel: '144p' },
  '298': { extensionHint: 'mp4', mediaHint: 'video', width: 1280, height: 720, qualityLabel: '720p60' },
  '299': { extensionHint: 'mp4', mediaHint: 'video', width: 1920, height: 1080, qualityLabel: '1080p60' },
  '302': { extensionHint: 'webm', mediaHint: 'video', width: 1280, height: 720, qualityLabel: '720p60' },
  '303': { extensionHint: 'webm', mediaHint: 'video', width: 1920, height: 1080, qualityLabel: '1080p60' },
  '308': { extensionHint: 'webm', mediaHint: 'video', width: 2560, height: 1440, qualityLabel: '1440p60' },
  '313': { extensionHint: 'webm', mediaHint: 'video', width: 3840, height: 2160, qualityLabel: '2160p' },
  '315': { extensionHint: 'webm', mediaHint: 'video', width: 3840, height: 2160, qualityLabel: '2160p60' },
  '330': { extensionHint: 'webm', mediaHint: 'video', width: 256, height: 144, qualityLabel: '144p60' },
  '331': { extensionHint: 'webm', mediaHint: 'video', width: 426, height: 240, qualityLabel: '240p60' },
  '332': { extensionHint: 'webm', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p60' },
  '333': { extensionHint: 'webm', mediaHint: 'video', width: 854, height: 480, qualityLabel: '480p60' },
  '394': { extensionHint: 'mp4', mediaHint: 'video', width: 256, height: 144, qualityLabel: '144p' },
  '395': { extensionHint: 'mp4', mediaHint: 'video', width: 426, height: 240, qualityLabel: '240p' },
  '396': { extensionHint: 'mp4', mediaHint: 'video', width: 640, height: 360, qualityLabel: '360p' },
  '397': { extensionHint: 'mp4', mediaHint: 'video', width: 854, height: 480, qualityLabel: '480p' },
  '398': { extensionHint: 'mp4', mediaHint: 'video', width: 1280, height: 720, qualityLabel: '720p' },
  '399': { extensionHint: 'mp4', mediaHint: 'video', width: 1920, height: 1080, qualityLabel: '1080p' },
  '400': { extensionHint: 'mp4', mediaHint: 'video', width: 2560, height: 1440, qualityLabel: '1440p' },
  '401': { extensionHint: 'mp4', mediaHint: 'video', width: 3840, height: 2160, qualityLabel: '2160p' },
  '402': { extensionHint: 'mp4', mediaHint: 'video', width: 7680, height: 4320, qualityLabel: '4320p' },
  // Audio-only itags
  '139': { extensionHint: 'm4a', mediaHint: 'audio', qualityLabel: 'audio' },
  '140': { extensionHint: 'm4a', mediaHint: 'audio', qualityLabel: 'audio' },
  '141': { extensionHint: 'm4a', mediaHint: 'audio', qualityLabel: 'audio' },
  '171': { extensionHint: 'webm', mediaHint: 'audio', qualityLabel: 'audio' },
  '172': { extensionHint: 'webm', mediaHint: 'audio', qualityLabel: 'audio' },
  '249': { extensionHint: 'webm', mediaHint: 'audio', qualityLabel: 'audio' },
  '250': { extensionHint: 'webm', mediaHint: 'audio', qualityLabel: 'audio' },
  '251': { extensionHint: 'webm', mediaHint: 'audio', qualityLabel: 'audio' },
};
