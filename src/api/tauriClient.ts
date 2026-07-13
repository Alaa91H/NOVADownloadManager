import type { AppSettings } from '../types/desktop-ui.types';
import { novaClient } from './novaClient';

interface FileWithPath extends File {
  path: string;
}

export interface DiagnosticData {
  cpuUsage: number | null;
  memoryUsageMb: number;
  diskFreeGb: number;
  activeThreads: number;
  daemonVersion: string;
  sqliteVersion: string;
  rustTarget: string;
  osName: string;
  networkInterfaces: Array<string | { name: string; ip: string; speedMbps?: number }>;
  version?: string;
  pid?: number;
  uptime?: number;
  jobs?: number;
  curlJobs?: number;
  mediaJobs?: number;
  curlAvailable?: boolean;
  ytdlpAvailable?: boolean;
  ffmpegAvailable?: boolean;
  directEngine?: string;
  mediaEngine?: string;
  postProcessor?: string;
  engineCapabilities?: Record<string, unknown>;
}

export interface BrowserExtensionPaths {
  devPath: string;
  resourcePath: string;
}

export interface FileOperationResult {
  success: boolean;
  message: string;
  changed?: boolean;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  installerUrl: string;
}

export interface VpnRouteValidation {
  ok: boolean;
  message: string;
}

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const tauri = window.__TAURI_INTERNALS__;
  if (tauri) {
    return tauri.invoke(cmd, args);
  }
  throw new Error('Not running in Tauri');
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function getBuildVersion(): Promise<string> {
  try {
    return (await invoke('get_version')) as string;
  } catch {
    return (import.meta.env.VITE_APP_VERSION as string) || '0.1.0';
  }
}

function normalizeVersion(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[+-]/, 1)[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isVersionGreater(latest: string, current: string): boolean {
  const latestParts = normalizeVersion(latest);
  const currentParts = normalizeVersion(current);
  const length = Math.max(latestParts.length, currentParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const latestPart = latestParts[index] || 0;
    const currentPart = currentParts[index] || 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }
  return false;
}

function installerAssetUrl(assets: unknown[], fallbackUrl: string): string {
  const candidates = assets
    .map((asset) => (asset && typeof asset === 'object' ? (asset as Record<string, unknown>) : null))
    .filter((asset): asset is Record<string, unknown> => Boolean(asset))
    .map((asset) => ({
      name: typeof asset.name === 'string' ? asset.name.toLowerCase() : '',
      url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
    }))
    .filter((asset) => asset.url);

  return (
    candidates.find((asset) => asset.name.includes('setup') && asset.name.endsWith('.exe'))?.url ||
    candidates.find((asset) => asset.name.endsWith('.exe'))?.url ||
    candidates.find((asset) => asset.name.endsWith('.msi'))?.url ||
    fallbackUrl
  );
}

function parseProxyEndpoint(proxyUrl: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(proxyUrl);
    const protocol = parsed.protocol.toLowerCase();
    const defaultPort = protocol.startsWith('socks') ? 1080 : protocol === 'https:' ? 443 : 80;
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : defaultPort,
    };
  } catch {
    return null;
  }
}

/** Get the daemon URL from the Tauri Rust backend. */
export async function getDaemonUrl(): Promise<string> {
  try {
    const url = (await invoke('get_daemon_url')) as string;
    if (url && typeof url === 'string') return url.replace(/\/$/, '');
  } catch {
    // Not running in Tauri - leave the API base empty so Vite's dev proxy
    // handles routing; in production the daemon serves the built frontend.
  }
  return '';
}

/** Get the daemon API bearer token from the Tauri Rust backend. */
export async function getDaemonToken(): Promise<string> {
  try {
    const token = (await invoke('get_daemon_token')) as string;
    if (token && typeof token === 'string') return token;
  } catch {
    // Not running in Tauri (e.g. browser dev): no token to attach.
  }
  return '';
}

export const tauriClient = {
  async checkDaemonHealth(): Promise<{
    status: 'connected' | 'degraded';
    version: string;
    pid: number;
    buildVersion: string;
  }> {
    const health = await novaClient.health();

    const curlReady = health.engines.curl.available;
    const directEngine = curlReady ? 'curl direct engine ready' : 'curl direct engine missing';
    const mediaEngine = health.engines.ytdlp.available ? 'media engine ready' : 'media engine missing';

    return {
      status: curlReady ? 'connected' : 'degraded',
      version: `${health.name} ${health.version} (${directEngine}; ${mediaEngine})`,
      pid: health.pid,
      buildVersion: await getBuildVersion(),
    };
  },

  async restartDaemon(): Promise<boolean> {
    try {
      await invoke('restart_daemon');
      return true;
    } catch (e) {
      console.warn('tauriClient: restartDaemon failed', e);
      return false;
    }
  },

  async checkUnsignedUpdate(): Promise<UpdateCheckResult> {
    const currentVersion = await getBuildVersion();
    const releasesUrl =
      (import.meta.env.VITE_NOVA_RELEASE_API_URL as string | undefined) ||
      'https://api.github.com/repos/Alaa91H/NovaDownloadManager/releases/latest';
    const response = await fetch(releasesUrl, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      throw new Error(`Update check failed (${String(response.status)}).`);
    }
    const release = (await response.json()) as Record<string, unknown>;
    const latestVersion =
      (typeof release.tag_name === 'string' && release.tag_name) ||
      (typeof release.name === 'string' && release.name) ||
      currentVersion;
    const releaseUrl =
      (typeof release.html_url === 'string' && release.html_url) ||
      'https://github.com/Alaa91H/NovaDownloadManager/releases';
    const assets = Array.isArray(release.assets) ? release.assets : [];
    return {
      currentVersion,
      latestVersion,
      hasUpdate: isVersionGreater(latestVersion, currentVersion),
      releaseUrl,
      installerUrl: installerAssetUrl(assets, releaseUrl),
    };
  },

  async openExternalUrl(url: string): Promise<boolean> {
    try {
      await invoke('open_external_url', { url });
      return true;
    } catch {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') {
          console.warn('openExternalUrl: blocked non-http(s) URL', parsed.protocol);
          return false;
        }
      } catch {
        console.warn('openExternalUrl: invalid URL');
        return false;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    }
  },

  async validateVpnRoute(settings: AppSettings): Promise<VpnRouteValidation> {
    if (!settings.extra.vpnEnabled || !settings.extra.vpnKillSwitch) {
      return { ok: true, message: 'VPN kill switch is not enforced.' };
    }

    if (settings.extra.vpnMode === 'proxy') {
      const endpoint = parseProxyEndpoint(settings.extra.vpnProxyUrl.trim());
      if (!endpoint || !endpoint.host || !Number.isFinite(endpoint.port)) {
        return { ok: false, message: 'Enter a valid VPN proxy URL before starting downloads.' };
      }
      try {
        const reachable = (await invoke('check_tcp_endpoint', endpoint)) as boolean;
        return reachable
          ? { ok: true, message: 'VPN proxy endpoint is reachable.' }
          : { ok: false, message: 'VPN proxy endpoint is not reachable.' };
      } catch (error) {
        return { ok: false, message: errorMessage(error, 'Could not validate the VPN proxy endpoint.') };
      }
    }

    if (settings.extra.vpnMode === 'bind') {
      const address = settings.extra.vpnBindAddress.trim();
      if (!address) {
        return { ok: false, message: 'Enter the VPN adapter/source address before starting downloads.' };
      }
      try {
        const available = (await invoke('validate_source_address', { address })) as boolean;
        return available
          ? { ok: true, message: 'VPN source address is active on this device.' }
          : { ok: false, message: 'VPN source address is not active on this device.' };
      } catch (error) {
        return { ok: false, message: errorMessage(error, 'Could not validate the VPN source address.') };
      }
    }

    try {
      const detected = (await invoke('detect_vpn_interface')) as boolean;
      return detected
        ? { ok: true, message: 'An active VPN-like interface was detected.' }
        : {
            ok: false,
            message: 'No active VPN interface was detected. Use proxy or bind mode if this is a false negative.',
          };
    } catch (error) {
      return { ok: false, message: errorMessage(error, 'Could not inspect VPN interfaces.') };
    }
  },

  async getDiagnostics(): Promise<DiagnosticData> {
    return await novaClient.diagnostics();
  },

  /**
   * TCP-connect to a DNS resolver endpoint and measure the round-trip latency.
   * Returns whether the endpoint is reachable and the observed latency in
   * milliseconds (null when unreachable or outside Tauri).
   */
  async probeDnsEndpoint(host: string, port = 443): Promise<{ reachable: boolean; latencyMs: number | null }> {
    const start = performance.now();
    try {
      const reachable = (await invoke('check_tcp_endpoint', { host, port })) as boolean;
      const latencyMs = reachable ? Math.round(performance.now() - start) : null;
      return { reachable, latencyMs };
    } catch {
      return { reachable: false, latencyMs: null };
    }
  },

  /** The OS user's Downloads folder; empty string outside Tauri. */
  async getDownloadsDir(): Promise<string> {
    try {
      return (await invoke('get_downloads_dir')) as string;
    } catch {
      return '';
    }
  },

  async triggerNativeNotification(title: string, body: string): Promise<boolean> {
    if ('Notification' in window) {
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') {
          new Notification(`NOVA: ${title}`, { body });
        } else if (Notification.permission !== 'denied') {
          const permission = await Notification.requestPermission();
          if (permission === 'granted') {
            new Notification(`NOVA: ${title}`, { body });
          }
        }
      }
    }
    return true;
  },

  async showDirectoryPicker(defaultPath?: string): Promise<string | null> {
    // Try native Tauri dialog first.
    try {
      const result = await invoke('plugin:dialog|open', {
        directory: true,
        multiple: false,
        defaultPath: defaultPath || '',
      });
      if (result && typeof result === 'string') return result;
    } catch {
      /* fall through to browser fallback */
    }

    // Browser fallback: hidden <input webkitdirectory> (works in WebView2 / Chrome).
    return new Promise<string | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.setAttribute('webkitdirectory', '');
      input.style.display = 'none';
      input.addEventListener('change', () => {
        if (input.files && input.files.length > 0) {
          const path = (input.files[0] as FileWithPath).path;
          if (path) {
            const sep = path.includes('\\') ? '\\' : '/';
            const dir = path.substring(0, path.lastIndexOf(sep));
            resolve(dir || null);
          } else {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
      document.body.appendChild(input);
      input.click();
      setTimeout(() => {
        document.body.removeChild(input);
      }, 1000);
    });
  },

  async showSaveFilePicker(fileName: string): Promise<string | null> {
    try {
      const result = await invoke('plugin:dialog|save', {
        defaultPath: fileName,
        filters: [{ name: 'All Files', extensions: ['*'] }],
      });
      if (result && typeof result === 'string') return result;
    } catch {
      /* fall through */
    }
    return null;
  },

  async openInExplorer(filePath: string): Promise<boolean> {
    try {
      await invoke('open_extension_folder', { path: filePath });
      return true;
    } catch {
      return false;
    }
  },

  async openDownloadedFile(filePath: string): Promise<boolean> {
    try {
      await invoke('open_file', { path: filePath });
      return true;
    } catch (e) {
      console.warn('tauriClient: openDownloadedFile failed', e);
      return false;
    }
  },

  async revealDownloadedFile(filePath: string): Promise<boolean> {
    try {
      await invoke('reveal_file', { path: filePath });
      return true;
    } catch (e) {
      console.warn('tauriClient: revealDownloadedFile failed', e);
      return false;
    }
  },

  async deleteDownloadedFile(filePath: string): Promise<FileOperationResult> {
    try {
      const deleted = (await invoke('delete_downloaded_file', { path: filePath })) as boolean;
      return {
        success: true,
        changed: deleted,
        message: deleted ? 'The downloaded file was deleted from disk.' : 'The downloaded file was already missing.',
      };
    } catch (e) {
      return {
        success: false,
        message: errorMessage(e, 'The downloaded file could not be deleted from disk.'),
      };
    }
  },

  async scanDownloadedFile(filePath: string): Promise<boolean> {
    try {
      await invoke('scan_downloaded_file', { path: filePath });
      return true;
    } catch (e) {
      console.warn('tauriClient: scanDownloadedFile failed', e);
      return false;
    }
  },

  async getBrowserExtensionPaths(): Promise<BrowserExtensionPaths> {
    try {
      const paths = (await invoke('get_browser_extension_paths')) as { dev_path: string; resource_path: string };
      return {
        devPath: paths.dev_path,
        resourcePath: paths.resource_path,
      };
    } catch {
      return {
        devPath: '../../browser-extension',
        resourcePath: 'C:\\Program Files\\Nova Download Manager\\resources\\browser-extension',
      };
    }
  },

  async openBrowserExtensions(browser: 'chrome' | 'edge' | 'firefox'): Promise<boolean> {
    try {
      await invoke('open_browser_extensions', { browser });
      return true;
    } catch {
      const urls = {
        chrome: 'chrome://extensions',
        edge: 'edge://extensions',
        firefox: 'about:debugging#/runtime/this-firefox',
      };
      window.open(urls[browser], '_blank', 'noopener,noreferrer');
      return false;
    }
  },

  async executeFile(filePath: string): Promise<{ success: boolean; message: string }> {
    try {
      await invoke('open_file', { path: filePath });
      return { success: true, message: 'Opening file with the system default application.' };
    } catch (e) {
      return { success: false, message: errorMessage(e, 'The file could not be opened.') };
    }
  },

  async saveConfigToDisk(settings: AppSettings): Promise<boolean> {
    try {
      const { encryptCredentials } = await import('../utils/crypto');
      const encrypted = await encryptCredentials(settings as unknown as Record<string, unknown>);
      await invoke('save_config', { settings: JSON.stringify(encrypted) });
      return true;
    } catch {
      return false;
    }
  },
};
