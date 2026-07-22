import browser from 'webextension-polyfill';
import { bridgeManager } from '../bridge/bridge-manager';
import { SettingsStore } from '../storage/settings-store';
import { MigrationStore } from '../storage/migration-store';
import { updateBadge } from './badge';
import { scheduleReconnect } from './alarms';
import { handleManualCapture } from './download-interceptor';
import { enforceAggressivePermissions } from '../profiles/aggressive-permission-enforcer';
import { AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE } from '../profiles/aggressive-capture-profile';
import { PermissionPolicy } from '../rules/permission-policy';
import { catchAndIgnore } from '../core/safe-catch';

const permissionPolicy = new PermissionPolicy();

let keepAliveInterval: ReturnType<typeof setInterval> | undefined;

function startKeepAlive(): void {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(async () => {
    try {
      await browser.storage.local.get('__keepalive__');
    } catch {
      // service worker may be shutting down
    }
  }, 15000);
}

function _stopKeepAlive(): void {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = undefined;
  }
}

function isDownloadUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const ext = u.pathname.split('.').pop()?.toLowerCase() || '';
    const exts = new Set([
      'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst',
      'exe', 'msi', 'dmg', 'pkg', 'appimage', 'deb', 'rpm',
      'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm',
      'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac',
      'pdf', 'epub', 'mobi', 'cbz', 'cbr',
      'iso', 'img', 'torrent', 'apk', 'ipa',
    ]);
    if (exts.has(ext)) return true;
    if (/\.(?:download|bin|dat|part)\b/i.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

function captureUrl(url: string, referrer: string): void {
  // runtime.sendMessage is never delivered to the sender's own context, so
  // the background must invoke the capture handler directly. The previous
  // self-message made navigation capture dead code.
  void handleManualCapture({ url, referrer, source: 'navigation-capture' }).catch(() => {});
}

export function registerLifecycle(): void {
  startKeepAlive();

  // Re-register keep-alive on startup/install
  browser.runtime.onStartup.addListener(() => {
    startKeepAlive();
    void maybeAutoConnect();
  });

  browser.runtime.onInstalled.addListener((details) => {
    startKeepAlive();
    if (details.reason === 'install') {
      // Store builds ship capture permissions as OPTIONAL. Nothing else
      // requests them proactively, so a fresh store install captured
      // nothing at all. Request once on install (Firefox grants from
      // background; Chrome requires a user gesture and surfaces the grant
      // action in the popup instead).
      void requestCapturePermissionsOnInstall();
    }
    void maybeAutoConnect();
  });

  // Respond to keep-alive pings
  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).type === '__ping__') {
      return Promise.resolve({ alive: true });
    }
    return undefined;
  });

  // ── Navigation interception: detect tab navigations to download URLs ──
  // This catches downloads triggered by window.location.href assignment
  // that bypass content script patching.
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url) return;
    if (!isDownloadUrl(changeInfo.url)) return;
    const url: string = changeInfo.url;

    // Don't capture NOVA's own downloads (they go to localhost)
    try {
      const host = new URL(url).hostname;
      if (host === '127.0.0.1' || host === 'localhost') return;
    } catch { /* ignore */ }

    const ref: string = tab.url ?? '';
    void catchAndIgnore((async () => {
      const settings = await new SettingsStore().get().catch(() => null);
      if (!settings?.enabled) return;
      captureUrl(url, ref);
    })(), 'lifecycle:navigation-capture');
  });
}

async function requestCapturePermissionsOnInstall(): Promise<void> {
  try {
    const missingPerms: string[] = [];
    const missingOrigins: string[] = [];
    for (const permission of AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions) {
      if (!(await permissionPolicy.has([permission], []))) missingPerms.push(permission);
    }
    for (const origin of AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins) {
      if (!(await permissionPolicy.has([], [origin]))) missingOrigins.push(origin);
    }
    if (missingPerms.length === 0 && missingOrigins.length === 0) return;
    await permissionPolicy.request(missingPerms, missingOrigins);
  } catch {
    // Chrome rejects background permission requests without a user gesture.
  }
}

async function maybeAutoConnect(): Promise<void> {
  try {
    await new MigrationStore().migrate();
    await enforceAggressivePermissions('lifecycle.auto-connect');
    const settings = await new SettingsStore().get();
    if (!settings.enabled || !settings.autoConnect) {
      await updateBadge(bridgeManager.getState());
      return;
    }
    const state = await bridgeManager.autoConnect();
    await updateBadge(state);
    if (!state.canSend && state.lastError?.retryable && state.retryAfterMs) {
      await scheduleReconnect(state.retryAfterMs);
    }
  } catch {
    // boot failed — will retry on next event
  }
}
