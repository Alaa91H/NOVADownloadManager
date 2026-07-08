/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getDaemonUrl,
  tauriClient,
  normalizeVersion,
  isVersionGreater,
  installerAssetUrl,
  parseProxyEndpoint,
  errorMessage,
  getBuildVersion,
} from '../tauriClient';
import type { AppSettings } from '../../types/desktop-ui.types';

describe('errorMessage', () => {
  it('returns error.message for Error instances', () => {
    expect(errorMessage(new Error('custom error'), 'fallback')).toBe('custom error');
  });

  it('returns fallback for non-Error values', () => {
    expect(errorMessage('string error', 'fallback')).toBe('fallback');
    expect(errorMessage(null, 'fallback')).toBe('fallback');
    expect(errorMessage(42, 'fallback')).toBe('fallback');
    expect(errorMessage({}, 'fallback')).toBe('fallback');
  });
});

describe('normalizeVersion', () => {
  it('parses a standard semver', () => {
    expect(normalizeVersion('1.2.3')).toEqual([1, 2, 3]);
  });

  it('strips leading v prefix', () => {
    expect(normalizeVersion('v2.0.1')).toEqual([2, 0, 1]);
  });

  it('strips pre-release suffix', () => {
    expect(normalizeVersion('1.0.0-beta.1')).toEqual([1, 0, 0]);
  });

  it('strips build metadata', () => {
    expect(normalizeVersion('1.0.0+build123')).toEqual([1, 0, 0]);
  });

  it('handles version with fewer than 3 parts', () => {
    expect(normalizeVersion('1.0')).toEqual([1, 0]);
  });

  it('handles non-numeric parts as 0', () => {
    expect(normalizeVersion('1.a.3')).toEqual([1, 0, 3]);
  });
});

describe('isVersionGreater', () => {
  it('returns true when latest is greater', () => {
    expect(isVersionGreater('2.0.0', '1.9.9')).toBe(true);
  });

  it('returns false when latest is equal', () => {
    expect(isVersionGreater('1.0.0', '1.0.0')).toBe(false);
  });

  it('returns false when latest is smaller', () => {
    expect(isVersionGreater('1.0.0', '2.0.0')).toBe(false);
  });

  it('handles different segment counts', () => {
    expect(isVersionGreater('1.0.0.1', '1.0.0')).toBe(true);
    expect(isVersionGreater('1.0', '1.0.0')).toBe(false);
  });

  it('handles pre-release tags correctly', () => {
    expect(isVersionGreater('1.0.1', '1.0.0-alpha')).toBe(true);
    expect(isVersionGreater('1.0.0', '1.0.0-beta')).toBe(false);
  });
});

describe('installerAssetUrl', () => {
  it('prefers setup exe over plain exe', () => {
    const assets = [
      { name: 'app.msi', browser_download_url: 'https://example.com/app.msi' },
      { name: 'Setup.exe', browser_download_url: 'https://example.com/setup.exe' },
      { name: 'app.exe', browser_download_url: 'https://example.com/app.exe' },
    ];
    expect(installerAssetUrl(assets, '')).toBe('https://example.com/setup.exe');
  });

  it('falls back to any exe', () => {
    const assets = [
      { name: 'app.msi', browser_download_url: 'https://example.com/app.msi' },
      { name: 'app.exe', browser_download_url: 'https://example.com/app.exe' },
    ];
    expect(installerAssetUrl(assets, '')).toBe('https://example.com/app.exe');
  });

  it('falls back to msi', () => {
    const assets = [{ name: 'app.msi', browser_download_url: 'https://example.com/app.msi' }];
    expect(installerAssetUrl(assets, '')).toBe('https://example.com/app.msi');
  });

  it('returns fallback when no matching assets', () => {
    expect(
      installerAssetUrl(
        [{ name: 'source.zip', browser_download_url: 'https://example.com/source.zip' }],
        'https://fallback',
      ),
    ).toBe('https://fallback');
  });

  it('handles empty assets array', () => {
    expect(installerAssetUrl([], 'https://fallback')).toBe('https://fallback');
  });

  it('filters out invalid asset entries', () => {
    const assets = [null, undefined, 'string', { name: 'Setup.exe' }];
    expect(installerAssetUrl(assets, 'https://fallback')).toBe('https://fallback');
  });
});

describe('parseProxyEndpoint', () => {
  it('parses an http proxy URL', () => {
    const result = parseProxyEndpoint('http://proxy.example.com:8080');
    expect(result).toEqual({ host: 'proxy.example.com', port: 8080 });
  });

  it('uses default port 80 for http', () => {
    const result = parseProxyEndpoint('http://proxy.example.com');
    expect(result?.port).toBe(80);
  });

  it('uses default port 443 for https', () => {
    const result = parseProxyEndpoint('https://proxy.example.com');
    expect(result?.port).toBe(443);
  });

  it('uses default port 1080 for socks', () => {
    const result = parseProxyEndpoint('socks5://proxy.example.com');
    expect(result?.port).toBe(1080);
    const result4 = parseProxyEndpoint('socks4://proxy.example.com');
    expect(result4?.port).toBe(1080);
  });

  it('returns null for invalid URL', () => {
    expect(parseProxyEndpoint('')).toBeNull();
    expect(parseProxyEndpoint('not-a-url')).toBeNull();
  });
});

describe('getDaemonUrl', () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('returns empty string when not in Tauri', async () => {
    const url = await getDaemonUrl();
    expect(url).toBe('');
  });

  it('returns daemon URL from Tauri invoke', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue('http://127.0.0.1:3199'),
    };
    const url = await getDaemonUrl();
    expect(url).toBe('http://127.0.0.1:3199');
  });

  it('strips trailing slash from Tauri URL', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue('http://127.0.0.1:3199/'),
    };
    const url = await getDaemonUrl();
    expect(url).toBe('http://127.0.0.1:3199');
  });
});

describe('getBuildVersion', () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    delete import.meta.env.VITE_APP_VERSION;
  });

  it('falls back to VITE_APP_VERSION env var', async () => {
    import.meta.env.VITE_APP_VERSION = '0.2.0';
    const version = await getBuildVersion();
    expect(version).toBe('0.2.0');
  });

  it('falls back to 0.1.0 when no version source', async () => {
    const version = await getBuildVersion();
    expect(version).toBe('0.1.0');
  });

  it('returns version from Tauri invoke', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue('0.3.0'),
    };
    const version = await getBuildVersion();
    expect(version).toBe('0.3.0');
  });
});

describe('tauriClient.checkDaemonHealth', () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('returns connected status when curl is available', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue('1.0.0'),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          name: 'NOVA',
          version: '1.0.0',
          pid: 1234,
          engines: { curl: { available: true }, ytdlp: { available: true } },
        }),
      status: 200,
    });

    const result = await tauriClient.checkDaemonHealth();
    expect(result.status).toBe('connected');
    expect(result.pid).toBe(1234);

    globalThis.fetch = originalFetch;
  });

  it('returns degraded status when curl is unavailable', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue('1.0.0'),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          name: 'NOVA',
          version: '1.0.0',
          pid: 5678,
          engines: { curl: { available: false }, ytdlp: { available: false } },
        }),
      status: 200,
    });

    const result = await tauriClient.checkDaemonHealth();
    expect(result.status).toBe('degraded');

    globalThis.fetch = originalFetch;
  });
});

describe('tauriClient.restartDaemon', () => {
  it('returns true when invoke succeeds', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue(undefined),
    };
    const result = await tauriClient.restartDaemon();
    expect(result).toBe(true);
  });

  it('returns false when invoke fails', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockRejectedValue(new Error('fail')),
    };
    const result = await tauriClient.restartDaemon();
    expect(result).toBe(false);
  });
});

describe('tauriClient.openExternalUrl', () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    window.open = vi.fn();
  });

  it('uses Tauri invoke when available', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue(undefined),
    };
    const result = await tauriClient.openExternalUrl('https://example.com');
    expect(result).toBe(true);
  });

  it('falls back to window.open outside Tauri', async () => {
    const result = await tauriClient.openExternalUrl('https://example.com');
    expect(result).toBe(true);
    expect(window.open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });
});

describe('tauriClient.openDownloadedFile', () => {
  it('returns true when invoke succeeds', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue(undefined),
    };
    const result = await tauriClient.openDownloadedFile('/path/to/file');
    expect(result).toBe(true);
  });

  it('returns false when invoke fails', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockRejectedValue(new Error('fail')),
    };
    const result = await tauriClient.openDownloadedFile('/path/to/file');
    expect(result).toBe(false);
  });
});

describe('tauriClient.revealDownloadedFile', () => {
  it('returns true when invoke succeeds', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue(undefined),
    };
    const result = await tauriClient.revealDownloadedFile('/path/to/file');
    expect(result).toBe(true);
  });

  it('returns false when invoke fails', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockRejectedValue(new Error('fail')),
    };
    const result = await tauriClient.revealDownloadedFile('/path/to/file');
    expect(result).toBe(false);
  });
});

describe('tauriClient.deleteDownloadedFile', () => {
  it('returns success when invoke returns true', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue(true),
    };
    const result = await tauriClient.deleteDownloadedFile('/path/to/file');
    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
  });

  it('returns success with changed=false when invoke returns false', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue(false),
    };
    const result = await tauriClient.deleteDownloadedFile('/path/to/file');
    expect(result.success).toBe(true);
    expect(result.changed).toBe(false);
  });

  it('returns failure when invoke throws', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockRejectedValue(new Error('permission denied')),
    };
    const result = await tauriClient.deleteDownloadedFile('/path/to/file');
    expect(result.success).toBe(false);
    expect(result.message).toContain('permission denied');
  });
});

describe('tauriClient.scanDownloadedFile', () => {
  it('returns true when invoke succeeds', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue(undefined),
    };
    const result = await tauriClient.scanDownloadedFile('/path/to/file');
    expect(result).toBe(true);
  });

  it('returns false when invoke fails', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockRejectedValue(new Error('fail')),
    };
    const result = await tauriClient.scanDownloadedFile('/path/to/file');
    expect(result).toBe(false);
  });
});

describe('tauriClient.getDownloadsDir', () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('returns empty string outside Tauri', async () => {
    const result = await tauriClient.getDownloadsDir();
    expect(result).toBe('');
  });

  it('returns path from Tauri invoke', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue('/home/user/Downloads'),
    };
    const result = await tauriClient.getDownloadsDir();
    expect(result).toBe('/home/user/Downloads');
  });
});

describe('tauriClient.executeFile', () => {
  it('returns success when invoke succeeds', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue(undefined),
    };
    const result = await tauriClient.executeFile('/path/to/file.exe');
    expect(result.success).toBe(true);
  });

  it('returns failure when invoke fails', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockRejectedValue(new Error('not found')),
    };
    const result = await tauriClient.executeFile('/path/to/file.exe');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });
});

describe('tauriClient.saveConfigToDisk', () => {
  it('returns true when invoke succeeds', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue(undefined),
    };
    const result = await tauriClient.saveConfigToDisk({} as AppSettings);
    expect(result).toBe(true);
  });

  it('returns false when invoke fails', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockRejectedValue(new Error('fail')),
    };
    const result = await tauriClient.saveConfigToDisk({} as AppSettings);
    expect(result).toBe(false);
  });
});

describe('tauriClient.openInExplorer', () => {
  it('returns true when invoke succeeds', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue(undefined),
    };
    const result = await tauriClient.openInExplorer('/path/to/folder');
    expect(result).toBe(true);
  });

  it('returns false when invoke fails', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockRejectedValue(new Error('fail')),
    };
    const result = await tauriClient.openInExplorer('/path/to/folder');
    expect(result).toBe(false);
  });
});

describe('tauriClient.getBrowserExtensionPaths', () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('returns fallback paths outside Tauri', async () => {
    const result = await tauriClient.getBrowserExtensionPaths();
    expect(result.devPath).toContain('browser-extension');
    expect(result.resourcePath).toContain('Program Files');
  });

  it('returns paths from Tauri invoke', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue({ dev_path: '/dev/path', resource_path: '/res/path' }),
    };
    const result = await tauriClient.getBrowserExtensionPaths();
    expect(result.devPath).toBe('/dev/path');
    expect(result.resourcePath).toBe('/res/path');
  });
});

describe('tauriClient.openBrowserExtensions', () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    window.open = vi.fn();
  });

  it('uses Tauri invoke when available', async () => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue(undefined),
    };
    const result = await tauriClient.openBrowserExtensions('chrome');
    expect(result).toBe(true);
  });

  it('falls back to window.open outside Tauri', async () => {
    const result = await tauriClient.openBrowserExtensions('chrome');
    expect(result).toBe(false);
    expect(window.open).toHaveBeenCalledWith('chrome://extensions', '_blank');
  });

  it('opens edge://extensions for edge browser', async () => {
    const result = await tauriClient.openBrowserExtensions('edge');
    expect(result).toBe(false);
    expect(window.open).toHaveBeenCalledWith('edge://extensions', '_blank');
  });
});

describe('tauriClient.validateVpnRoute', () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('returns ok when VPN is disabled', async () => {
    const settings = { extra: { vpnEnabled: false } } as AppSettings;
    const result = await tauriClient.validateVpnRoute(settings);
    expect(result.ok).toBe(true);
  });

  it('returns ok when kill switch is disabled', async () => {
    const settings = { extra: { vpnEnabled: true, vpnKillSwitch: false } } as AppSettings;
    const result = await tauriClient.validateVpnRoute(settings);
    expect(result.ok).toBe(true);
  });
});

describe('tauriClient.triggerNativeNotification', () => {
  beforeEach(() => {
    (window as any).Notification = undefined;
  });

  it('returns true when Notification API is unavailable', async () => {
    const result = await tauriClient.triggerNativeNotification('title', 'body');
    expect(result).toBe(true);
  });
});
