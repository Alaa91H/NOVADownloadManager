import browser from 'webextension-polyfill';
import { defineContentScript } from 'wxt/utils/define-content-script';

const DOWNLOAD_EXTS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst',
  'exe', 'msi', 'dmg', 'pkg', 'appimage', 'deb', 'rpm',
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm',
  'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac',
  'pdf', 'epub', 'mobi', 'cbz', 'cbr',
  'iso', 'img', 'vhd', 'vmdk',
  'dll', 'so', 'dylib',
  'ttf', 'otf', 'woff', 'woff2',
  'csv', 'xlsx', 'docx', 'pptx',
  'apk', 'ipa',
  'torrent',
]);

function isDownloadUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const ext = u.pathname.split('.').pop()?.toLowerCase() || '';
    if (DOWNLOAD_EXTS.has(ext)) return true;
    if (/\.(?:download|bin|dat|part)\b/i.test(u.pathname)) return true;
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
      const setting = changes['settings']?.newValue as { enabled?: boolean } | undefined;
      if (setting) {
        isNovaEnabled = setting.enabled !== false;
      }
    });

    browser.storage.local.get('settings').then((r: Record<string, unknown>) => {
      const setting = r['settings'] as { enabled?: boolean } | undefined;
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
        captureUrl(href, 'download-attribute', anchor.getAttribute('download') || undefined);
        return;
      }

      if (isDownloadUrl(href)) {
        const isMiddleClick = mouseEvent.button === 1;
        if (isMiddleClick) {
          e.preventDefault();
          e.stopPropagation();
        }
        captureUrl(href, 'link-click');
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
      if (this.href && isDownloadUrl(this.href)) {
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
  },
});
