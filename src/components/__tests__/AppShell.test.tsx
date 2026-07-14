import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { initialSettings } from '../../initialData';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    close: vi.fn(),
    show: vi.fn(),
    setFocus: vi.fn(),
    hide: vi.fn(),
  }),
  ProgressBarStatus: { None: 0, Normal: 1 },
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn().mockResolvedValue('') }));

const noop = vi.fn();
const settings = { ...initialSettings, extra: { ...initialSettings.extra, language: 'en' } };

vi.mock('../../store/selectors', () => ({
  useTaskData: () => [],
  useTaskSelectors: () => ({ selectedTaskId: null, tasks: [], activeCount: 0, queuedCount: 0, completedCount: 0, pausedCount: 0, errorCount: 0, selectedTask: null }),
  useTaskActions: () => ({ pauseTask: noop, resumeTask: noop, deleteTask: noop, setSelectedTaskId: noop, addTask: noop, openTaskFile: noop, openTaskLocation: noop, updateTaskProperties: noop, triggerBatchDownload: noop }),
  useSettingsData: () => settings,
  useSettingsActions: () => ({ updateSettings: noop, updateThemeSettings: noop }),
  useThemeData: () => ({ theme: 'dark', density: 'compact', accent: 'blue', progress: 'bar', contrast: 'normal' }),
  useBridgeData: () => ({ status: 'connected' as const, version: '1.0', pid: 1234, speedLimit: null }),
  useIsDegraded: () => false,
  useDialogData: () => ({ active: null, payload: null }),
  useDialogActions: () => ({ openDialog: noop, closeDialog: noop }),
  useToastData: () => [],
  useToastActions: () => ({ addToast: noop, removeToast: noop }),
  useNavigationData: () => ({ activePage: 'downloads' as const, workspaceView: 'all' as const }),
  useNavigationActions: () => ({ setActivePage: noop, setWorkspaceView: noop }),
  useSearchQuery: () => ({ searchQuery: '', setSearchQuery: noop }),
  useNotificationsData: () => ({ isNotificationsMuted: false, setIsNotificationsMuted: noop }),
  useMinimizedProgress: () => ({ activeProgressMinimizedToTaskbar: false, minimizedProgressTask: null, minimizeActiveProgressToTaskbar: noop, setActiveProgressMinimizedToTaskbar: noop, setMinimizedProgressTask: noop }),
  useI18n: () => (k: string) => {
    if (k === 'app_name') return 'NOVA Download Manager';
    return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  },
}));

import { AppShell } from '../AppShell';

describe('AppShell', () => {
  it('renders the app title', () => {
    render(<AppShell />);
    expect(screen.getByText('NOVA Download Manager')).toBeInTheDocument();
  });
});
