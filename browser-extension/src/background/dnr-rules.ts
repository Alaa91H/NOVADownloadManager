import browser from 'webextension-polyfill';
import { SettingsStore } from '../storage/settings-store';

let dnrReady = false;

// Shared extension list — sync with download-capture.content.ts DOWNLOAD_EXTS
const DOWNLOAD_EXTS = [
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst',
  'exe', 'msi', 'dmg', 'pkg', 'appimage', 'deb', 'rpm',
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm',
  'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac',
  'pdf', 'epub', 'mobi', 'cbz', 'cbr',
  'iso', 'img', 'torrent',
  'apk', 'ipa',
];

function buildBlockRules(): browser.DeclarativeNetRequest.Rule[] {
  const rules: browser.DeclarativeNetRequest.Rule[] = [];
  let id = 1;
  const resourceTypes: browser.DeclarativeNetRequest.ResourceType[] = [
    'main_frame', 'sub_frame', 'object', 'other',
  ];
  for (const ext of DOWNLOAD_EXTS) {
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'block' },
      condition: {
        regexFilter: `\\.${reEscape(ext)}(\\?.*)?$`,
        resourceTypes,
      },
    });
  }
  return rules;
}

function reEscape(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function installDnrRules(): Promise<void> {
  if (dnrReady) return;
  const settings = await new SettingsStore().get().catch(
    () => ({ enabled: false, capture: { downloads: false, aggressiveMode: false } }),
  );
  if (!settings.enabled || (!settings.capture.downloads && !settings.capture.aggressiveMode)) return;
  if (!browser.declarativeNetRequest?.updateDynamicRules) return;

  try {
    const existing = await browser.declarativeNetRequest.getDynamicRules();
    const keep = existing.filter((r) => (r.priority ?? 1) >= 100);
    const existingIds = existing.map((r) => r.id);
    const newRules = buildBlockRules();
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds.filter((id) => !keep.some((k) => k.id === id)),
      addRules: newRules,
    });
    dnrReady = true;
  } catch {
    // DNR not supported
  }
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
