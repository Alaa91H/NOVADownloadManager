import browser from 'webextension-polyfill';
import { SettingsStore } from '../storage/settings-store';

let dnrReady = false;

// Shared extension list — keep in sync with download-capture.content.ts DOWNLOAD_EXTS
const DOWNLOAD_EXTS = [
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
        regexFilter: `\\.${reEscape(ext)}([?#].*)?$`,
        resourceTypes,
        isUrlFilterCaseSensitive: false,
      },
    });
  }

  // Block common download API endpoint patterns
  const downloadEndpointPatterns = [
    '\\/download\\b',
    '\\/downloads\\/.*\\?attachment',
    '\\?download=1',
    '\\?attachment=1',
    '\\/dl\\/',
    '\\/getfile\\/',
    '\\/get-file\\/',
  ];
  for (const pattern of downloadEndpointPatterns) {
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'block' },
      condition: {
        regexFilter: pattern,
        resourceTypes,
        isUrlFilterCaseSensitive: false,
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
