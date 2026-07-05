import { AppSettings } from '../types/desktop-ui.types';
import { novaClient } from './novaClient';

interface FileWithPath extends File {
  path: string;
}

export interface DiagnosticData {
  cpuUsage: number;
  memoryUsageMb: number;
  diskFreeGb: number;
  activeThreads: number;
  daemonVersion: string;
  sqliteVersion: string;
  rustTarget: string;
  osName: string;
  networkInterfaces: Array<{ name: string; ip: string; speedMbps: number }>;
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

export const tauriClient = {
  async checkDaemonHealth(): Promise<{
    status: 'connected' | 'degraded';
    version: string;
    pid: number;
    buildVersion: string;
  }> {
    const health = await novaClient.health();

    const aria2Ready = health.engines.aria2.rpcReady;
    const directEngine = aria2Ready ? 'direct engine ready' : 'direct engine starting';
    const mediaEngine = health.engines.ytdlp.available ? 'media engine ready' : 'media engine missing';

    return {
      status: aria2Ready ? 'connected' : 'degraded',
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

  async getDiagnostics(): Promise<DiagnosticData> {
    return await novaClient.diagnostics();
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
        options: { directory: true, multiple: false, defaultPath: defaultPath || '' },
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
        options: { defaultPath: fileName, filters: [{ name: 'All Files', extensions: ['*'] }] },
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

  async openExternalUrl(url: string): Promise<boolean> {
    try {
      await invoke('open_external_url', { url });
      return true;
    } catch {
      window.open(url, '_blank');
      return false;
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
      window.open(urls[browser], '_blank');
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
      await invoke('save_config', { settings: JSON.stringify(settings) });
      return true;
    } catch {
      return false;
    }
  },
};
