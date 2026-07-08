import type { OverlaySettings } from '../contracts/settings.schema';
import {
  MAX_OVERLAY_HINT_ELEMENTS,
  MAX_OVERLAY_HINT_SOURCE_ELEMENTS,
  MAX_OVERLAY_HINT_VIDEO_ELEMENTS,
  NOISE_DOMAIN_PATTERNS,
  OVERLAY_MEDIA_TYPE_BY_EXTENSION,
  type OverlayMediaType,
  SMART_VIDEO_OVERLAY_MEDIA_TYPES,
  SMART_VIDEO_URL_HINT_RE,
  VIDEO_LINK_SELECTOR,
  VIDEO_OVERLAY_DISCOVERY_SOURCE,
  VIDEO_OVERLAY_DISCOVERY_TYPE,
} from './overlay-types';
import { urlsFromAttribute } from './scan-page';

function isNoiseUrl(url: string): boolean {
  try {
    return NOISE_DOMAIN_PATTERNS.test(new URL(url, location.href).hostname);
  } catch {
    return NOISE_DOMAIN_PATTERNS.test(url);
  }
}

function isSmartVideoOverlayContext(): boolean {
  const host = location.hostname.toLowerCase();
  const path = location.pathname.toLowerCase();
  if (
    (host === 'youtube.com' || host.endsWith('.youtube.com')) &&
    /^\/(watch|shorts|live)(?:\/|$)/.test(path)
  )
    return true;
  if (
    host.includes('vimeo.com') ||
    host.includes('dailymotion.com') ||
    host.includes('twitch.tv') ||
    host.includes('kick.com')
  )
    return true;
  if (document.querySelector('video,audio')) return true;
  if (
    document.querySelector(
      'iframe[src*="youtube"],iframe[src*="vimeo"],iframe[src*="dailymotion"],iframe[src*="twitch"]',
    )
  )
    return true;
  const ogType =
    document
      .querySelector('meta[property="og:type"],meta[name="og:type"]')
      ?.getAttribute('content') ?? '';
  if (/video/i.test(ogType)) return true;
  if (
    document.querySelector(
      'meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[property="og:video:type"],meta[name="twitter:player"]',
    )
  )
    return true;
  if (
    document.querySelector(
      'link[rel="alternate"][type^="video/"],link[rel="alternate"][href*=".m3u8"],link[rel="alternate"][href*=".mpd"]',
    )
  )
    return true;
  return false;
}

function isSmartVideoUrlHint(url: string, type?: string | null): boolean {
  const mime = type?.toLowerCase() ?? '';
  if (mime.startsWith('video/') || mime.includes('mpegurl') || mime.includes('dash+xml'))
    return true;
  return SMART_VIDEO_URL_HINT_RE.test(url);
}

function extensionHintFromUrl(value: string): string | undefined {
  if (/^magnet:/i.test(value)) return 'magnet';
  try {
    const pathname = new URL(value, document.baseURI || location.href).pathname;
    const match = pathname.match(/\.([a-z0-9]{1,16})$/i);
    return match?.[1]?.toLowerCase();
  } catch {
    const fallbackPath = value.split(/[?#]/, 1)[0] ?? value;
    const match = fallbackPath.match(/\.([a-z0-9]{1,16})$/i);
    return match?.[1]?.toLowerCase();
  }
}

function mediaTypeHintFromUrl(
  value: string,
  tag?: string | null,
  type?: string | null,
): OverlayMediaType {
  if (/^magnet:/i.test(value)) return 'magnet';
  const mime = type?.toLowerCase() ?? '';
  if (mime.includes('mpegurl') || mime.includes('dash+xml')) return 'manifest';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  const ext = extensionHintFromUrl(value);
  return ext
    ? (OVERLAY_MEDIA_TYPE_BY_EXTENSION[ext] ?? 'other')
    : tag === 'video'
      ? 'video'
      : tag === 'audio'
        ? 'audio'
        : tag === 'img'
          ? 'image'
          : 'other';
}

function normalizedOverlayExtensionSet(values: string[]): Set<string> {
  return new Set(
    values.map((value) => value.trim().replace(/^\.+/, '').toLowerCase()).filter(Boolean),
  );
}

function overlayHintMatchesSettings(
  url: string,
  settings: OverlaySettings,
  tag?: string | null,
  type?: string | null,
  smartVideoMode = false,
): boolean {
  const mediaType = mediaTypeHintFromUrl(url, tag, type);
  if (
    smartVideoMode &&
    !SMART_VIDEO_OVERLAY_MEDIA_TYPES.has(mediaType) &&
    !isSmartVideoUrlHint(url, type)
  )
    return false;
  const extension = extensionHintFromUrl(url);
  const allowlist = normalizedOverlayExtensionSet(settings.extensionsAllowlist);
  const blocklist = normalizedOverlayExtensionSet(settings.extensionsBlocklist);
  if (extension && blocklist.has(extension)) return false;
  if (allowlist.size > 0 && (!extension || !allowlist.has(extension))) return false;
  return settings.mediaTypes.includes(mediaType);
}

function hasOverlayCandidateHint(settings?: OverlaySettings): boolean {
  const smartVideoMode = Boolean(settings?.smartVideoOnlyOnVideoPages && isSmartVideoOverlayContext());

  let checkedVideos = 0;
  for (const video of document.querySelectorAll('video')) {
    if (checkedVideos >= MAX_OVERLAY_HINT_VIDEO_ELEMENTS) break;
    checkedVideos += 1;
    const node = video as HTMLVideoElement;
    const urls: string[] = [];
    if (node.currentSrc) urls.push(node.currentSrc);
    if (node.src && node.src !== node.currentSrc) urls.push(node.src);
    let checkedSources = 0;
    for (const source of node.querySelectorAll('source[src]')) {
      if (checkedSources >= MAX_OVERLAY_HINT_SOURCE_ELEMENTS) break;
      checkedSources += 1;
      const sourceUrl = source.getAttribute('src');
      if (sourceUrl) urls.push(sourceUrl);
    }
    if (urls.length === 0 && node.readyState > 0)
      return !settings || settings.mediaTypes.includes('video');
    if (
      urls.some(
        (url) =>
          !settings ||
          overlayHintMatchesSettings(url, settings, 'video', node.getAttribute('type'), smartVideoMode),
      )
    )
      return true;
  }

  let checkedElements = 0;
  for (const element of document.querySelectorAll(VIDEO_LINK_SELECTOR)) {
    if (checkedElements >= MAX_OVERLAY_HINT_ELEMENTS) break;
    checkedElements += 1;
    const tag = element.tagName.toLowerCase();
    const type =
      element.getAttribute('type') ||
      element.getAttribute('property') ||
      element.getAttribute('name');
    const rawValues = [
      'href',
      'src',
      'srcset',
      'content',
      'data-video',
      'data-video-src',
      'data-video-url',
      'data-mp4',
      'data-hls',
      'data-hls-url',
      'data-m3u8',
      'data-m3u8-url',
      'data-dash',
      'data-dash-url',
      'data-mpd',
      'data-mpd-url',
      'data-master',
      'data-manifest',
      'data-stream',
      'data-stream-url',
      'data-source',
      'data-media',
      'data-media-url',
      'data-content',
      'data-file',
      'data-file-url',
    ].flatMap((attr) => urlsFromAttribute(element.getAttribute(attr), attr));
    const filtered = rawValues.filter((url) => !isNoiseUrl(url));
    if (
      filtered.some(
        (url) => !settings || overlayHintMatchesSettings(url, settings, tag, type, smartVideoMode),
      )
    )
      return true;
  }

  checkedElements = 0;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (checkedElements >= 20) break;
    checkedElements += 1;
    try {
      const parsed = JSON.parse(script.textContent ?? '');
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item?.['@type'] === 'VideoObject' && item?.contentUrl) {
          if (
            !settings ||
            overlayHintMatchesSettings(item.contentUrl, settings, 'a', null, smartVideoMode)
          )
            return true;
        }
      }
    } catch {
      continue;
    }
  }

  checkedElements = 0;
  for (const iframe of document.querySelectorAll('iframe[src]')) {
    if (checkedElements >= 20) break;
    checkedElements += 1;
    const src = iframe.getAttribute('src') ?? '';
    if (
      /(?:youtube|youtu\.be|vimeo|dailymotion|twitch|kick\.com)\/(?:embed|video|watch)\//i.test(
        src,
      )
    ) {
      if (!settings || overlayHintMatchesSettings(src, settings, 'iframe', null, smartVideoMode))
        return true;
    }
  }

  return false;
}

function hasVideoCandidate(): boolean {
  return hasOverlayCandidateHint();
}

function postVideoCandidateToTopFrame(): void {
  try {
    window.top?.postMessage(
      {
        source: VIDEO_OVERLAY_DISCOVERY_SOURCE,
        type: VIDEO_OVERLAY_DISCOVERY_TYPE,
      },
      '*',
    );
  } catch {
    // Some pages aggressively sandbox frames; local scanning still works where allowed.
  }
}

export {
  isNoiseUrl,
  isSmartVideoOverlayContext,
  isSmartVideoUrlHint,
  extensionHintFromUrl,
  mediaTypeHintFromUrl,
  normalizedOverlayExtensionSet,
  overlayHintMatchesSettings,
  hasOverlayCandidateHint,
  hasVideoCandidate,
  postVideoCandidateToTopFrame,
};
