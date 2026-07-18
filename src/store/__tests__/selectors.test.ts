import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTaskData, useTaskSelectors, useTaskActions, useQueueData, useQueueActions, useSettingsData, useThemeData, useBridgeData, useIsDegraded, useDialogData, useToastData, useNavigationData, useSearchQuery, useNotificationsData, useMinimizedProgress, useI18n } from '../selectors';
import { taskStore } from '../taskStore';
import { settingsStore } from '../settingsStore';
import { bridgeStore } from '../bridgeStore';
import { uiStore } from '../uiStore';
import { initialSettings } from '../../initialData';

vi.mock('../../utils/sound', () => ({ playAppSound: vi.fn() }));
vi.mock('../../api/tauriClient', () => ({
  tauriClient: {
    saveConfigToDisk: vi.fn().mockResolvedValue(undefined),
    openDownloadedFile: vi.fn().mockResolvedValue(true),
    revealDownloadedFile: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock('../../api/novaClient', () => ({
  novaClient: {
    createDownload: vi.fn().mockImplementation((item: Record<string, unknown>) => Promise.resolve({ ...item, id: 'mock_id' })),
    pauseDownload: vi.fn().mockImplementation((id: string) => Promise.resolve({ id, status: 'paused' })),
    resumeDownload: vi.fn().mockImplementation((id: string) => Promise.resolve({ id, status: 'downloading' })),
    deleteDownload: vi.fn().mockResolvedValue(undefined),
  },
}));

const resetStores = () => {
  taskStore.setState({
    tasks: [
      { id: 't1', name: 'a.zip', url: 'http://a.zip', fileType: 'compressed', status: 'downloading', sizeBytes: 100, downloadedBytes: 50, speedBytesPerSec: 10, timeLeftSeconds: 5, category: 'other', queueId: 'main', connections: 4, resumable: true, savePath: '', description: '', elapsedSeconds: 0, segments: [], dateAdded: '2024-01-01T00:00:00Z' },
      { id: 't2', name: 'b.pdf', url: 'http://b.pdf', fileType: 'other', status: 'completed', sizeBytes: 200, downloadedBytes: 200, speedBytesPerSec: 0, timeLeftSeconds: 0, category: 'other', queueId: 'main', connections: 4, resumable: true, savePath: '', description: '', elapsedSeconds: 0, segments: [], dateAdded: '2024-01-02T00:00:00Z' },
      { id: 't3', name: 'c.mp4', url: 'http://c.mp4', fileType: 'video', status: 'queued', sizeBytes: 0, downloadedBytes: 0, speedBytesPerSec: 0, timeLeftSeconds: 0, category: 'other', queueId: 'main', connections: 0, resumable: true, savePath: '', description: '', elapsedSeconds: 0, segments: [], dateAdded: '2024-01-03T00:00:00Z' },
    ],
    completedTaskIds: new Set(),
    hasSyncedDownloads: false,
  });
  uiStore.setState({ selectedTaskId: 't1', activePage: 'downloads', workspaceView: 'all', searchQuery: '', dialog: { active: null }, toasts: [], isNotificationsMuted: false, activeProgressMinimizedToTaskbar: false, minimizedProgressTask: null });
  settingsStore.setState({
    settings: { ...initialSettings, extra: { ...initialSettings.extra, language: 'en', browserPairingToken: 'test' } },
    themeSettings: { theme: 'system', density: 'compact', accent: 'blue', progress: 'bar', contrast: 'normal' },
    i18nRevision: 0,
  });
  bridgeStore.setState({ status: 'connected', version: '1.0', pid: 1234, speedLimit: null, isDegradedMode: false });
};

describe('selectors', () => {
  beforeEach(resetStores);

  describe('useTaskData', () => {
    it('returns tasks array', () => {
      const { result } = renderHook(() => useTaskData());
      expect(result.current).toHaveLength(3);
    });
  });

  describe('useTaskSelectors', () => {
    it('returns selectedTaskId', () => {
      const { result } = renderHook(() => useTaskSelectors());
      expect(result.current.selectedTaskId).toBe('t1');
    });
  });

  describe('useTaskActions', () => {
    it('returns action functions', () => {
      const { result } = renderHook(() => useTaskActions());
      expect(typeof result.current.addTask).toBe('function');
      expect(typeof result.current.pauseTask).toBe('function');
      expect(typeof result.current.resumeTask).toBe('function');
      expect(typeof result.current.deleteTask).toBe('function');
    });
  });

  describe('useQueueData', () => {
    it('returns queues', () => {
      const { result } = renderHook(() => useQueueData());
      expect(result.current.length).toBeGreaterThan(0);
    });
  });

  describe('useQueueActions', () => {
    it('returns action functions', () => {
      const { result } = renderHook(() => useQueueActions());
      expect(typeof result.current.addQueue).toBe('function');
      expect(typeof result.current.deleteQueue).toBe('function');
      expect(typeof result.current.undoLast).toBe('function');
    });
  });

  describe('useSettingsData', () => {
    it('returns settings', () => {
      const { result } = renderHook(() => useSettingsData());
      expect(result.current.general).toBeDefined();
    });
  });

  describe('useThemeData', () => {
    it('returns theme settings', () => {
      const { result } = renderHook(() => useThemeData());
      expect(result.current.theme).toBe('system');
    });
  });

  describe('useBridgeData', () => {
    it('returns bridge data', () => {
      const { result } = renderHook(() => useBridgeData());
      expect(result.current.status).toBe('connected');
      expect(result.current.version).toBe('1.0');
    });
  });

  describe('useIsDegraded', () => {
    it('returns degraded mode flag', () => {
      const { result } = renderHook(() => useIsDegraded());
      expect(result.current).toBe(false);
    });
  });

  describe('useDialogData', () => {
    it('returns dialog state', () => {
      const { result } = renderHook(() => useDialogData());
      expect(result.current.active).toBeNull();
    });
  });

  describe('useToastData', () => {
    it('returns toasts', () => {
      const { result } = renderHook(() => useToastData());
      expect(result.current).toEqual([]);
    });
  });

  describe('useNavigationData', () => {
    it('returns page and workspace', () => {
      const { result } = renderHook(() => useNavigationData());
      expect(result.current.activePage).toBe('downloads');
      expect(result.current.workspaceView).toBe('all');
    });
  });

  describe('useSearchQuery', () => {
    it('returns search query', () => {
      const { result } = renderHook(() => useSearchQuery());
      expect(result.current.searchQuery).toBe('');
    });
  });

  describe('useNotificationsData', () => {
    it('returns muted state', () => {
      const { result } = renderHook(() => useNotificationsData());
      expect(result.current.isNotificationsMuted).toBe(false);
    });
  });

  describe('useMinimizedProgress', () => {
    it('returns minimized progress state', () => {
      const { result } = renderHook(() => useMinimizedProgress());
      expect(result.current.activeProgressMinimizedToTaskbar).toBe(false);
      expect(result.current.minimizedProgressTask).toBeNull();
    });
  });

  describe('useI18n', () => {
    it('returns a function', () => {
      const { result } = renderHook(() => useI18n());
      expect(typeof result.current).toBe('function');
    });

    it('returns translation for known key', () => {
      const { result } = renderHook(() => useI18n());
      const translated = result.current('settings.title');
      expect(typeof translated).toBe('string');
    });
  });
});
