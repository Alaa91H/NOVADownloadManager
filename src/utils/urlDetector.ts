export type UrlType = 'media' | 'download' | 'unknown';

const MEDIA_PATTERNS = [
  { host: /(?:www\.)?youtube\.com$/i, path: /\/watch\?v=/ },
  { host: /youtu\.be$/i, path: /\/.+/ },
  { host: /(?:www\.)?vimeo\.com$/i, path: /\/(?:channels\/)?\d+/ },
  { host: /(?:www\.)?tiktok\.com$/i, path: /\/@.+\/video\// },
  { host: /(?:www\.)?soundcloud\.com$/i, path: /\/.+/ },
  { host: /(?:www\.)?instagram\.com$/i, path: /\/(?:p|reel)\// },
  { host: /(?:www\.)?twitter\.com$/i, path: /\/\w+\/status\// },
  { host: /x\.com$/i, path: /\/\w+\/status\// },
];

export function detectUrlType(url: string): UrlType {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, '');
    const pathname = parsed.pathname;

    for (const pattern of MEDIA_PATTERNS) {
      if (pattern.host.test(hostname) && pattern.path.test(pathname)) {
        return 'media';
      }
      if (pattern.host.test(hostname)) {
        return 'media';
      }
    }

    if (hostname === 'youtube.com' || hostname === 'youtu.be') {
      return 'media';
    }

    return 'download';
  } catch {
    return 'unknown';
  }
}

export function getDialogForUrl(url: string): string {
  const type = detectUrlType(url);
  if (type === 'media') return 'youtubeDownload';
  return 'addDownload';
}
