import { AppSettings } from '../types/desktop-ui.types';
import { novaClient } from './novaClient';

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

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const tauri = (window as any).__TAURI_INTERNALS__;
  if (tauri) {
    return tauri.invoke(cmd, args);
  }
  throw new Error('Not running in Tauri');
}

async function getBuildVersion(): Promise<string> {
  try {
    return (await invoke('get_version')) as string;
  } catch {
    return import.meta.env.VITE_APP_VERSION || '0.1.0';
  }
}

export const tauriClient = {
  async checkDaemonHealth(): Promise<{ status: 'connected'; version: string; pid: number; buildVersion: string }> {
    const health = await novaClient.health();
    if (health.status !== 'connected') {
      const errors = [
        health.engines.aria2.error ? 'Direct download engine unavailable or not ready' : '',
        health.engines.ytdlp.error ? 'Media engine unavailable' : ''
      ].filter(Boolean).join('; ');
      throw new Error(errors || 'NOVA daemon is degraded');
    }

    const directEngine = health.engines.aria2.available
      ? `direct engine ${health.engines.aria2.rpcReady ? 'ready' : 'starting'}`
      : 'direct engine missing';
    const mediaEngine = health.engines.ytdlp.available
      ? 'media engine ready'
      : 'media engine missing';

    return {
      status: 'connected',
      version: `${health.name} ${health.version} (${directEngine}; ${mediaEngine})`,
      pid: health.pid,
      buildVersion: await getBuildVersion()
    };
  },

  async restartDaemon(): Promise<boolean> {
    try {
      await invoke('restart_daemon');
      return true;
    } catch {
      return false;
    }
  },

  async getDiagnostics(): Promise<DiagnosticData> {
    return await novaClient.diagnostics();
  },

  async triggerNativeNotification(title: string, body: string): Promise<boolean> {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(`NOVA: ${title}`, { body });
      } else if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          new Notification(`NOVA: ${title}`, { body });
        }
      }
    }
    return true;
  },

  async showDirectoryPicker(defaultPath?: string): Promise<string | null> {
    void defaultPath;
    return null;
  },

  async showSaveFilePicker(fileName: string): Promise<string | null> {
    void fileName;
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

  async getBrowserExtensionPaths(): Promise<BrowserExtensionPaths> {
    try {
      const paths = await invoke('get_browser_extension_paths') as { dev_path: string; resource_path: string };
      return {
        devPath: paths.dev_path,
        resourcePath: paths.resource_path,
      };
    } catch {
      return {
        devPath: 'C:\\Users\\Alaa\\Desktop\\NOVA\\browser-extension',
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
      window.open(urls[browser], '_blank');
      return false;
    }
  },

  async executeFile(filePath: string): Promise<{ success: boolean; message: string }> {
    void filePath;
    return { success: false, message: 'File execution is not available from the browser UI.' };
  },

  async saveConfigToDisk(settings: AppSettings): Promise<boolean> {
    void settings;
    return true;
  }
};
