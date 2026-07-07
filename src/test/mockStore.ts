import { vi } from 'vitest';
import { initialSettings } from '../initialData';

export function createMockStore(overrides: Record<string, unknown> = {}) {
  return {
    t: (k: string, _params?: Record<string, string | number>) => {
      if (k === 'lang_name') return 'English';
      if (k === 'app_name') return 'NOVA Download Manager';
      if (k === 'status_downloading') return 'Downloading';
      if (k === 'status_completed') return 'Completed';
      return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    },
    bridge: { status: 'disconnected' as const, version: '', pid: 0, uptime: 0, speedLimit: null },
    workspaceView: 'all' as const,
    setWorkspaceView: vi.fn(),
    tasks: [],
    openDialog: vi.fn(),
    addToast: vi.fn(),
    settings: initialSettings,
    themeSettings: {
      theme: 'dark' as const,
      density: 'normal' as const,
      accent: 'blue' as const,
      sidebar: 'expanded' as const,
      progress: 'bar' as const,
      contrast: 'normal' as const,
      motion: 'enabled' as const,
      blur: 'enabled' as const,
    },
    toasts: [],
    removeToast: vi.fn(),
    searchQuery: '',
    setSearchQuery: vi.fn(),
    selectedTaskId: null,
    setSelectedTaskId: vi.fn(),
    isLoading: false,
    dialog: { active: null, payload: null },
    activePage: 'downloads' as const,
    setActivePage: vi.fn(),
    queues: [],
    isDegradedMode: false,
    isNotificationsMuted: false,
    setIsNotificationsMuted: vi.fn(),
    updatingTaskId: null,
    setUpdatingTaskId: vi.fn(),
    activeProgressMinimizedToTaskbar: false,
    setActiveProgressMinimizedToTaskbar: vi.fn(),
    minimizedProgressTask: null,
    setMinimizedProgressTask: vi.fn(),
    addTask: vi.fn(),
    pauseTask: vi.fn(),
    resumeTask: vi.fn(),
    deleteTask: vi.fn(),
    updateTaskProperties: vi.fn(),
    updateQueue: vi.fn(),
    addQueue: vi.fn(),
    deleteQueue: vi.fn(),
    removeTaskFromQueue: vi.fn(),
    moveTaskToQueue: vi.fn(),
    createQueueAndMoveTask: vi.fn(),
    updateSettings: vi.fn(),
    updateThemeSettings: vi.fn(),
    closeDialog: vi.fn(),
    triggerBatchDownload: vi.fn(),
    ...overrides,
  };
}
