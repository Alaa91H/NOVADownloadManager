import browser from 'webextension-polyfill';
import { defineContentScript } from 'wxt/utils/define-content-script';

const DOWNLOAD_EXTS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'lz4', 'cab',
  'exe', 'msi', 'msix', 'dmg', 'pkg', 'appimage', 'deb', 'rpm', 'run', 'bin',
  'mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', '3gp',
  'mp3', 'flac', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'wma', 'aiff', 'aif', 'ape', 'alac',
  'pdf', 'epub', 'mobi', 'azw3', 'cbz', 'cbr', 'djvu',
  'iso', 'img', 'vhd', 'vmdk', 'vdi',
  'dll', 'so', 'dylib', 'sys',
  'ttf', 'otf', 'woff', 'woff2',
  'csv', 'tsv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'odt', 'ods', 'rtf',
  'apk', 'xapk', 'ipa', 'aab',
  'torrent', 'nzb',
  'jar', 'war', 'ear', 'crx', 'xpi', 'vsix',
  'ps1', 'bat', 'cmd', 'sh', 'bash',
  'json', 'xml', 'yaml', 'yml', 'sql', 'db', 'sqlite',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic', 'raw',
  'srt', 'vtt', 'ass', 'ssa',
  'dat', 'part', 'download', 'crdownload',
]);

const SETTINGS_KEY = 'nova.settings';

const STREAM_SEGMENT_RE = /(?:\.ts(?:\?|$)|\.segment(?:\?|$)|\/segment\/|\/hls\/|\/dash\/|\/video\/.*\/seg(?:ment)?[s]?\/|\/media\/.*\.(?:m4s|cmfv|cmfa))/i;

function isDownloadUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (/[?&](?:download|attachment|export|file|filename)=/i.test(u.search)) return true;
    if (/\/(?:download|downloads|dl|getfile|get-file|attachment|export)(?:\/|$)/i.test(u.pathname)) return true;
    const ext = u.pathname.split('.').pop()?.toLowerCase() || '';
    if (ext && DOWNLOAD_EXTS.has(ext)) return true;
    if (/\.(?:download|bin|dat|part|crdownload)\b/i.test(u.pathname)) return true;
    if (STREAM_SEGMENT_RE.test(u.href)) return true;
    return false;
  } catch {
    return false;
  }
}

function captureUrl(url: string, source: string, filename?: string): void {
  browser.runtime.sendMessage({
    type: 'CAPTURE_DOWNLOAD',
    payload: {
      url,
      filename,
      referrer: document.location.href,
      tabId: undefined,
      source,
    },
  }).catch(() => {});
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    let isNovaEnabled = true;

    browser.storage.onChanged.addListener((changes: Record<string, browser.Storage.StorageChange>) => {
      const setting = changes[SETTINGS_KEY]?.newValue as { enabled?: boolean } | undefined;
      if (setting) {
        isNovaEnabled = setting.enabled !== false;
      }
    });

    browser.storage.local.get(SETTINGS_KEY).then((r: Record<string, unknown>) => {
      const setting = r[SETTINGS_KEY] as { enabled?: boolean } | undefined;
      if (setting) isNovaEnabled = setting.enabled !== false;
    }).catch(() => {});

    function guard(fn: (...args: any[]) => void): (...args: any[]) => void {
      return (...args: any[]) => { if (isNovaEnabled) fn(...args); };
    }

    // ── 1. Click handler (existing) ──────────────────────────────────────
    document.addEventListener('click', guard((e: Event) => {
      const mouseEvent = e as MouseEvent;
      let target = e.target as HTMLElement | null;
      while (target && target.tagName !== 'A' && target.tagName !== 'AREA') {
        target = target.parentElement;
      }
      const anchor = target as HTMLAnchorElement | HTMLAreaElement | null;
      if (!anchor?.href) return;
      const href = anchor.href;
      if (!href) return;
      if (mouseEvent.button !== 0 && mouseEvent.button !== 1) return;

      if (anchor.hasAttribute('download')) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        captureUrl(href, 'download-attribute', anchor.getAttribute('download') || undefined);
        return;
      }

      if (isDownloadUrl(href)) {
        // Absolute takeover: never let the browser start the download.
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        captureUrl(href, 'link-click', anchor.getAttribute('download') || undefined);
      }
    }), true);

    // ── 2. Context menu selection ───────────────────────────────────────
    document.addEventListener('contextmenu', guard(() => {
      const sel = window.getSelection()?.toString();
      if (!sel || !isDownloadUrl(sel)) return;
      captureUrl(sel, 'context-selection');
    }), true);

    // ── 3. Intercept JavaScript-triggered downloads ─────────────────────
    // Patch HTMLAnchorElement.prototype.click to detect programmatic clicks
    // on <a> elements pointing to download URLs (used by many sites including VLC).
    const OriginalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.href && (this.hasAttribute('download') || isDownloadUrl(this.href))) {
        captureUrl(this.href, 'programmatic-click', this.getAttribute('download') || undefined);
        return;
      }
      OriginalAnchorClick.call(this);
    };

    // Patch window.open to capture download URLs opened in new tabs/windows
    const OriginalOpen = window.open;
    window.open = function open(url?: string | URL, target?: string, features?: string) {
      const urlStr = url?.toString() || '';
      if (urlStr && isDownloadUrl(urlStr)) {
        captureUrl(urlStr, 'window-open');
        return null;
      }
      return OriginalOpen.call(window, url, target, features);
    } as typeof window.open;

    // Patch location.assign / replace for JS-driven file navigations
    try {
      const locProto = Object.getPrototypeOf(window.location) as Location;
      const originalAssign = locProto.assign.bind(window.location);
      const originalReplace = locProto.replace.bind(window.location);
      locProto.assign = function assign(url: string | URL) {
        const urlStr = url.toString();
        if (isDownloadUrl(urlStr)) {
          captureUrl(urlStr, 'location-assign');
          return;
        }
        return originalAssign(url);
      };
      locProto.replace = function replace(url: string | URL) {
        const urlStr = url.toString();
        if (isDownloadUrl(urlStr)) {
          captureUrl(urlStr, 'location-replace');
          return;
        }
        return originalReplace(url);
      };
    } catch {
      // Some browsers freeze Location.prototype — downloads API still covers those.
    }

    // ── 4. MutationObserver for dynamically created <a download> ────────
    const observer = new MutationObserver(guard(() => {
      const anchors = document.querySelectorAll<HTMLAnchorElement>('a[download]');
      anchors.forEach((a) => {
        if (!a.dataset.novaCaptured && a.href) {
          a.dataset.novaCaptured = 'true';
          a.addEventListener('click', guard((e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            captureUrl(a.href, 'dynamic-download-attr', a.getAttribute('download') || undefined);
          }), true);
        }
      });
    }));
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // ── 5. KEYBOARD: Intercept Enter/Space on focused download links ────
    document.addEventListener('keydown', guard((e: Event) => {
      const keyEvent = e as KeyboardEvent;
      if (keyEvent.key !== 'Enter' && keyEvent.key !== ' ') return;
      const active = document.activeElement as HTMLElement | null;
      if (!active) return;
      let el = active;
      while (el && el.tagName !== 'A') { el = el.parentElement as HTMLElement; }
      const anchor = el as HTMLAnchorElement | null;
      if (!anchor?.href || !isDownloadUrl(anchor.href)) return;
      if (anchor.hasAttribute('download') || isDownloadUrl(anchor.href)) {
        e.preventDefault();
        e.stopPropagation();
        captureUrl(anchor.href, 'keyboard-enter');
      }
    }), true);

    // ── 6. FORM SUBMISSION: Intercept forms targeting download endpoints ──
    document.addEventListener('submit', guard((e: Event) => {
      const form = e.target as HTMLFormElement | null;
      if (!form) return;
      const action = form.action || form.getAttribute('action') || '';
      const method = (form.method || 'GET').toUpperCase();
      if (!action) return;
      try {
        const actionUrl = new URL(action, document.location.href);
        if (isDownloadUrl(actionUrl.href) || /\/(?:download|dl|export|getfile|get-file|attachment)/i.test(actionUrl.pathname)) {
          e.preventDefault();
          e.stopPropagation();
          if (method === 'GET') {
            captureUrl(actionUrl.href, 'form-submit');
          } else {
            captureUrl(actionUrl.href, 'form-submit-post');
          }
        }
      } catch {
        // malformed action URL — let browser handle
      }
    }), true);

    // ── 7. BLOB URL CAPTURE: Intercept blob URL creation for downloads ───
    // When JS creates URL.createObjectURL(blob) and navigates to it or
    // assigns it to an <a href>, we capture the original blob type for
    // the content type hint.
    const OriginalCreateObjectURL = URL.createObjectURL;
    const blobUrlTypeMap = new Map<string, string>();
    URL.createObjectURL = function patchedCreateObjectURL(obj: Blob | MediaSource): string {
      const url = OriginalCreateObjectURL.call(this, obj);
      if (obj instanceof Blob && obj.type) {
        blobUrlTypeMap.set(url, obj.type);
      }
      return url;
    };

    // Watch for blob URLs assigned to anchor hrefs for download
    const blobDownloadObserver = new MutationObserver(guard(() => {
      const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href^="blob:"]');
      anchors.forEach((a) => {
        if (a.dataset.novaBlobWatched) return;
        a.dataset.novaBlobWatched = 'true';
        const blobType = blobUrlTypeMap.get(a.href);
        if (a.hasAttribute('download') || isDownloadableMime(blobType)) {
          a.addEventListener('click', guard((e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            captureUrl(a.href, 'blob-download', a.getAttribute('download') || undefined);
          }), true);
        }
      });
    }));
    blobDownloadObserver.observe(document.documentElement, { childList: true, subtree: true });

    // ── 8. NAVIGATE-TO-BLOB: Intercept navigation to blob: URLs ────────
    // Some sites do location.href = createObjectURL(blob)
    const OriginalAssign2 = window.location.assign;
    const OriginalReplace2 = window.location.replace;
    try {
      const locProto2 = Object.getPrototypeOf(window.location) as Location;
      const origAssign2 = locProto2.assign.bind(window.location);
      const origReplace2 = locProto2.replace.bind(window.location);
      locProto2.assign = function assign(url: string | URL) {
        const urlStr = url.toString();
        if (urlStr.startsWith('blob:') && isDownloadableMime(blobUrlTypeMap.get(urlStr))) {
          captureUrl(urlStr, 'location-assign-blob');
          return;
        }
        return origAssign2(url);
      };
      locProto2.replace = function replace(url: string | URL) {
        const urlStr = url.toString();
        if (urlStr.startsWith('blob:') && isDownloadableMime(blobUrlTypeMap.get(urlStr))) {
          captureUrl(urlStr, 'location-replace-blob');
          return;
        }
        return origReplace2(url);
      };
    } catch {
      // Some browsers freeze Location.prototype
    }
  },
});

function isDownloadableMime(mime?: string): boolean {
  if (!mime) return false;
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return true;
  if (/\b(?:mpegurl|dash\+xml)\b/i.test(mime)) return true;
  if (/application\/(?:pdf|epub|zip|gzip|octet-stream|x-tar|x-7z-compressed|x-rar-compressed)/i.test(mime)) return true;
  return false;
}
