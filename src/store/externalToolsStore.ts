import { create } from 'zustand';
import { novaClient } from '../api/novaClient';

export interface ExternalToolCapability {
  id: string;
  name: string;
  available: boolean;
  requires?: string;
}

export interface ExternalToolState {
  id: string;
  name: string;
  description: string;
  status: string;
  version?: string;
  latestVersion?: string;
  path?: string;
  customPath: boolean;
  installedByApp: boolean;
  capabilities: ExternalToolCapability[];
  updateAvailable: boolean;
  isInstalling: boolean;
  isUpdating: boolean;
  isUninstalling: boolean;
  healthOk: boolean;
  error?: string;
  downloadUrl?: string;
  sourceUrl?: string;
  sourceName?: string;
}

interface ExternalToolsStore {
  tools: ExternalToolState[];
  loading: boolean;
  lastRefresh: number;
  fetchTools: () => Promise<void>;
  discoverTool: (toolId: string) => Promise<void>;
  checkHealth: (toolId: string) => Promise<void>;
  checkForUpdates: (toolId: string) => Promise<void>;
  updateTool: (toolId: string) => Promise<void>;
  setCustomPath: (toolId: string, path: string) => Promise<void>;
  uninstallTool: (toolId: string) => Promise<void>;
  refreshAll: () => Promise<void>;
}

export const useExternalToolsStore = create<ExternalToolsStore>((set, get) => ({
  tools: [],
  loading: false,
  lastRefresh: 0,

  fetchTools: async () => {
    set({ loading: true });
    try {
      const data = await novaClient.listExternalTools();
      const tools: ExternalToolState[] = data.tools.map((t) => ({
        ...t,
        description: '',
        customPath: false,
        installedByApp: false,
        updateAvailable: false,
        latestVersion: undefined,
        isInstalling: false,
        isUpdating: false,
        isUninstalling: false,
        downloadUrl: undefined,
        sourceUrl: undefined,
        sourceName: undefined,
      }));
      set({ tools, loading: false, lastRefresh: Date.now() });
    } catch {
      set({ loading: false });
    }
  },

  discoverTool: async (toolId: string) => {
    try {
      await novaClient.discoverExternalTool(toolId);
      await get().fetchTools();
    } catch (e) {
      console.warn('discoverTool failed', e);
    }
  },

  checkHealth: async (toolId: string) => {
    try {
      await novaClient.checkExternalToolHealth(toolId);
      await get().fetchTools();
    } catch (e) {
      console.warn('checkHealth failed', e);
    }
  },

  checkForUpdates: async (toolId: string) => {
    try {
      const result = await novaClient.checkExternalToolUpdates(toolId);
      set((state) => ({
        tools: state.tools.map((t) =>
          t.id === toolId
            ? {
                ...t,
                updateAvailable: result.available,
                latestVersion: result.latestVersion,
                downloadUrl: result.downloadUrl,
              }
            : t,
        ),
      }));
    } catch (e) {
      console.warn('checkForUpdates failed', e);
    }
  },

  updateTool: async (toolId: string) => {
    set((state) => ({
      tools: state.tools.map((t) => (t.id === toolId ? { ...t, isUpdating: true } : t)),
    }));
    try {
      await novaClient.updateExternalTool(toolId);
      await get().fetchTools();
    } catch (e) {
      console.warn('updateTool failed', e);
      set((state) => ({
        tools: state.tools.map((t) => (t.id === toolId ? { ...t, isUpdating: false } : t)),
      }));
    }
  },

  setCustomPath: async (toolId: string, path: string) => {
    try {
      await novaClient.setExternalToolPath(toolId, path);
      await get().fetchTools();
    } catch (e) {
      console.warn('setCustomPath failed', e);
      throw e;
    }
  },

  uninstallTool: async (toolId: string) => {
    set((state) => ({
      tools: state.tools.map((t) => (t.id === toolId ? { ...t, isUninstalling: true } : t)),
    }));
    try {
      await novaClient.uninstallExternalTool(toolId);
      await get().fetchTools();
    } catch (e) {
      console.warn('uninstallTool failed', e);
      set((state) => ({
        tools: state.tools.map((t) => (t.id === toolId ? { ...t, isUninstalling: false } : t)),
      }));
    }
  },

  refreshAll: async () => {
    await get().fetchTools();
  },
}));
