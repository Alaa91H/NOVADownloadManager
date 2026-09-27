import browser from 'webextension-polyfill';
import { SettingsStore } from '../storage/settings-store';

let dnrReady = false;

// Shared extension list — keep in sync with download-capture.content.ts DOWNLOAD_EXTS.
// Retained for documentation and future opt-in DNR hardening; the block rules
// themselves are currently disabled (see installDnrRules).
export const DOWNLOAD_EXTS = [
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'lz4', 'cab',
  'exe', 'msi', 'msix', 'dmg', 'pkg', 'appimage', 'deb', 'rpm', 'run', 'bin',
  'mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', '3gp',
  'mp3', 'flac', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'wma', 'aiff', 'aif', 'ape', 'alac',
  'pdf', 'epub', 'mobi', 'azw3', 'cbz', 'cbr', 'djvu',
  'iso', 'img', 'vhd', 'vmdk', 'vdi',
  'apk', 'xapk', 'ipa', 'aab',
  'torrent', 'nzb',
  'jar', 'war', 'ear', 'crx', 'xpi', 'vsix',
  'csv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'odt', 'ods', 'rtf',
  'ttf', 'otf', 'woff', 'woff2',
  'srt', 'vtt', 'ass', 'ssa',
  'ps1', 'bat', 'cmd', 'sh', 'bash',
  'json', 'xml', 'yaml', 'yml', 'sql', 'db', 'sqlite',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic', 'raw',
];

export async function installDnrRules(): Promise<void> {
  if (dnrReady) return;
  const settings = await new SettingsStore().get().catch(
    () => ({ enabled: false, capture: { downloads: false, aggressiveMode: false } }),
  );
  if (!settings.enabled || (!settings.capture.downloads && !settings.capture.aggressiveMode)) return;
  if (!browser.declarativeNetRequest?.updateDynamicRules) return;

  // DNR block rules are DISABLED by default. When active they prevent the
  // browser from creating a download item at all, which means
  // downloads.onCreated never fires and NOVA cannot capture the URL.
  // The professional approach (used by IDM-style integrations) is to rely on
  // onCreated + cancel() for reliable capture, and treat DNR as optional
  // hardening that a user can opt into for sites where the browser shows a
  // Save As dialog too quickly.
  //
  // To re-enable: expose a settings.capture.dnrHardening flag and gate this
  // block on it. For now we remove any previously-installed rules so the
  // extension always captures via onCreated.
  await removeDnrRules().catch(() => {});
  dnrReady = true;
}

export async function removeDnrRules(): Promise<void> {
  if (!dnrReady) return;
  if (!browser.declarativeNetRequest?.updateDynamicRules) return;
  try {
    const existing = await browser.declarativeNetRequest.getDynamicRules();
    const removeIds = existing
      .filter((r) => (r.priority ?? 1) < 100)
      .map((r) => r.id);
    if (removeIds.length > 0) {
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: removeIds,
        addRules: [],
      });
    }
    dnrReady = false;
  } catch {
    // ignore
  }
}
