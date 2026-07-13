import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initialSettings } from '../../initialData';
import type { DownloadItem } from '../../types/desktop-ui.types';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));

type StoreOverrides = Record<string, unknown>;

const T_MAP: Record<string, string> = {
  topbar_new_download: 'New Download',
  topbar_new_download_tip: 'New Download',
  topbar_more_options: 'More Options',
  topbar_single_url: 'Single URL',
  topbar_batch_download: 'Batch Download',
  dlg_webpage_grabber: 'Webpage Grabber',
  dlg_media_downloader: 'Media Downloader',
  engine_caps_loading: 'Checking engine capabilities\u2026',
  engine_no_engine: 'Direct download & media engines are not available.',
  engine_unavailable_desc: 'Engine is unavailable.',
  engine_direct_unavailable: 'Direct engine is not available.',
  engine_media_unavailable: 'Media engine is not available.',
  topbar_scheduler_tip: 'Scheduler',
  nav_settings: 'Settings',
  topbar_search_placeholder: 'Search Downloads\u2026',
  topbar_resume_selected_tip: 'Resume selected download',
  topbar_resume_all_tip: 'Resume all downloads',
  topbar_resume_all_title: 'Resume All',
  topbar_resume_all_none: 'No downloads to resume.',
  topbar_resume_all_done: 'Resumed {count} downloads.',
  topbar_stop_selected_tip: 'Stop selected download',
  topbar_stop_all_tip: 'Stop all downloads',
  topbar_stop_all_title: 'Stop All',
  topbar_stop_all_none: 'No active downloads to stop.',
  topbar_stop_all_done: 'Stopped {count} downloads.',
  topbar_delete_selected_tip: 'Delete selected download',
  topbar_delete_all_tip: 'Delete all downloads',
  topbar_delete_all_title: 'Delete All',
  topbar_delete_all_none: 'No downloads to delete.',
  topbar_delete_all_done: 'Deleted {count} downloads.',
  topbar_delete_completed_title: 'Delete Completed',
  topbar_delete_completed_none: 'No completed downloads to delete.',
  topbar_delete_completed_done: 'Deleted {count} completed downloads.',
  topbar_delete_all_confirm: 'Delete all downloads?',
  topbar_delete_completed_confirm: 'Delete all completed downloads?',
  resume: 'Resume',
  topbar_resume_selected: 'Resume Selected',
  topbar_resume_all: 'Resume All',
  topbar_stop_selected: 'Stop Selected',
  topbar_stop_all: 'Stop All',
  topbar_delete_selected: 'Delete Selected',
  topbar_delete_all: 'Delete All',
  topbar_delete_completed: 'Delete Completed',
  telegram_send_file_title: 'Send File',
  telegram_send_file_no_file: 'No file to send.',
  telegram_send_file_ok: 'File sent successfully.',
  telegram_send_file_failed: 'Failed to send file.',
};

function makeStore(overrides: StoreOverrides = {}) {
  return {
    t: (k: string) => T_MAP[k] || k,
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
    openTaskFile: vi.fn(),
    openTaskLocation: vi.fn(),
    ...overrides,
  };
}

const mockStoreRef = { current: makeStore() };

vi.mock('../../state/appStore', () => ({
  useAppStore: () => mockStoreRef.current,
}));

const mockCaps = vi.hoisted(() => ({
  loading: false,
  error: null as string | null,
  raw: null,
  directReady: true,
  mediaReady: true,
  ffmpegReady: true,
  postProcessingReady: true,
  streamResolverReady: true,
  directEngineId: 'libcurl-multi',
  mediaEngineId: 'yt-dlp',
  postProcessorId: 'ffmpeg',
  directProtocols: ['http', 'https', 'ftp'],
  directOptionKeys: new Set<string>(),
  unsupportedDirectOptionKeys: new Set<string>(),
  mediaOptionKeys: new Set<string>(),
  unsupportedMediaOptionKeys: new Set<string>(),
  supportedExternalDownloaders: new Set<string>(),
  refresh: vi.fn(),
  supportsDirectOption: vi.fn(() => true),
  supportsMediaOption: vi.fn(() => true),
  supportsDirectProtocol: vi.fn(() => true),
  supportsStreamCandidate: vi.fn(() => true),
  sanitizeDirectOptions: vi.fn((o: unknown) => o),
  sanitizeMediaOptions: vi.fn((o: unknown) => o),
  directBlockedReason: vi.fn(() => null),
  mediaBlockedReason: vi.fn(() => null),
}));

vi.mock('../../capabilities/EngineCapabilityContext', () => ({
  useEngineCapabilities: () => mockCaps,
}));

import { TopBar } from '../TopBar';

function makeTask(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'task-1',
    name: 'test-file.zip',
    url: 'https://example.com/test-file.zip',
    fileType: 'compressed',
    status: 'downloading',
    sizeBytes: 1024 * 1024,
    downloadedBytes: 512 * 1024,
    speedBytesPerSec: 1024 * 100,
    timeLeftSeconds: 5,
    dateAdded: '2026-07-07',
    category: 'compressed',
    queueId: 'main',
    connections: 4,
    resumable: true,
    savePath: '/downloads/test-file.zip',
    description: '',
    segments: [],
    ...overrides,
  };
}

describe('TopBar', () => {
  beforeEach(() => {
    mockStoreRef.current = makeStore();
    mockCaps.loading = false;
    mockCaps.error = null;
    mockCaps.directReady = true;
    mockCaps.mediaReady = true;
    mockCaps.ffmpegReady = true;
    mockCaps.directBlockedReason = vi.fn(() => null);
    mockCaps.mediaBlockedReason = vi.fn(() => null);
  });

  it('renders new download button', () => {
    render(<TopBar />);
    expect(screen.getByTitle('New Download')).toBeInTheDocument();
  });

  it('renders scheduler button', () => {
    render(<TopBar />);
    expect(screen.getByTitle('Scheduler')).toBeInTheDocument();
  });

  it('renders settings button', () => {
    render(<TopBar />);
    expect(screen.getByTitle('Settings')).toBeInTheDocument();
  });

  it('renders search input', () => {
    render(<TopBar />);
    expect(screen.getByPlaceholderText('Search Downloads…')).toBeInTheDocument();
  });

  it('disables new download when both engines unavailable', () => {
    mockCaps.directReady = false;
    mockCaps.mediaReady = false;
    render(<TopBar />);
    expect(screen.getByTitle('Direct download & media engines are not available.')).toBeDisabled();
  });

  it('shows loading state when caps loading', () => {
    mockCaps.loading = true;
    mockCaps.directReady = false;
    mockCaps.mediaReady = false;
    render(<TopBar />);
    expect(screen.getByTitle('Checking engine capabilities…')).toBeDisabled();
  });

  it('enables new download when at least one engine ready', () => {
    mockCaps.directReady = true;
    mockCaps.mediaReady = false;
    render(<TopBar />);
    expect(screen.getByTitle('New Download')).not.toBeDisabled();
  });

  it('opens addDownload on new download click', () => {
    const openDialog = vi.fn();
    mockStoreRef.current = makeStore({ openDialog });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('New Download'));
    expect(openDialog).toHaveBeenCalledWith('addDownload');
  });

  it('opens scheduler on scheduler click', () => {
    const openDialog = vi.fn();
    mockStoreRef.current = makeStore({ openDialog });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Scheduler'));
    expect(openDialog).toHaveBeenCalledWith('scheduler');
  });

  it('opens settings on settings click', () => {
    const openDialog = vi.fn();
    mockStoreRef.current = makeStore({ openDialog });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Settings'));
    expect(openDialog).toHaveBeenCalledWith('settings');
  });

  it('calls setSearchQuery on search input change', () => {
    const setSearchQuery = vi.fn();
    mockStoreRef.current = makeStore({ setSearchQuery });
    render(<TopBar />);
    const input = screen.getByPlaceholderText('Search Downloads…');
    fireEvent.change(input, { target: { value: 'test' } });
    expect(setSearchQuery).toHaveBeenCalledWith('test');
  });

  it('resumes selected task', () => {
    const task = makeTask({ status: 'paused' });
    const resumeTask = vi.fn();
    mockStoreRef.current = makeStore({ tasks: [task], selectedTaskId: 'task-1', resumeTask });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Resume selected download'));
    expect(resumeTask).toHaveBeenCalledWith('task-1');
  });

  it('resumes all when no task selected', () => {
    const tasks = [makeTask({ id: 't1', status: 'paused' }), makeTask({ id: 't2', status: 'queued' })];
    const resumeTask = vi.fn();
    mockStoreRef.current = makeStore({ tasks, selectedTaskId: null, resumeTask });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Resume all downloads'));
    expect(resumeTask).toHaveBeenCalledTimes(2);
  });

  it('shows toast when no tasks to resume all', () => {
    const addToast = vi.fn();
    mockStoreRef.current = makeStore({ tasks: [], selectedTaskId: null, addToast });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Resume all downloads'));
    expect(addToast).toHaveBeenCalledWith('info', 'Resume All', 'No downloads to resume.');
  });

  it('stops selected task', () => {
    const task = makeTask({ status: 'downloading' });
    const pauseTask = vi.fn();
    mockStoreRef.current = makeStore({ tasks: [task], selectedTaskId: 'task-1', pauseTask });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Stop selected download'));
    expect(pauseTask).toHaveBeenCalledWith('task-1');
  });

  it('stops all when no selected task', () => {
    const tasks = [makeTask({ id: 't1', status: 'downloading' }), makeTask({ id: 't2', status: 'downloading' })];
    const pauseTask = vi.fn();
    mockStoreRef.current = makeStore({ tasks, selectedTaskId: null, pauseTask });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Stop all downloads'));
    expect(pauseTask).toHaveBeenCalledTimes(2);
  });

  it('shows toast when no active tasks to stop all', () => {
    const addToast = vi.fn();
    mockStoreRef.current = makeStore({ tasks: [], selectedTaskId: null, addToast });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Stop all downloads'));
    expect(addToast).toHaveBeenCalledWith('info', 'Stop All', 'No active downloads to stop.');
  });

  it('opens confirmDelete when task selected and delete clicked', () => {
    const task = makeTask({ status: 'paused' });
    const openDialog = vi.fn();
    mockStoreRef.current = makeStore({ tasks: [task], selectedTaskId: 'task-1', openDialog });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Delete selected download'));
    expect(openDialog).toHaveBeenCalledWith('confirmDelete', task);
  });

  it('opens genericConfirm when delete with no selection but tasks exist', () => {
    const openDialog = vi.fn();
    mockStoreRef.current = makeStore({ tasks: [makeTask()], selectedTaskId: null, openDialog });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Delete all downloads'));
    expect(openDialog).toHaveBeenCalledWith('genericConfirm', expect.objectContaining({ isDanger: true }));
  });

  it('does nothing when deleting all with no tasks', () => {
    const addToast = vi.fn();
    mockStoreRef.current = makeStore({ tasks: [], addToast });
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Delete all downloads'));
    expect(addToast).not.toHaveBeenCalled();
  });

  it('renders new download dropdown items', () => {
    mockCaps.directReady = true;
    mockCaps.mediaReady = true;
    render(<TopBar />);
    const chevron = screen.getAllByRole('button').find((b) => b.querySelector('.lucide-chevron-down'));
    expect(chevron).toBeDefined();
    if (chevron) fireEvent.click(chevron);
    expect(screen.getByText('Single URL')).toBeInTheDocument();
    expect(screen.getByText('Batch Download')).toBeInTheDocument();
    expect(screen.getByText('Webpage Grabber')).toBeInTheDocument();
    expect(screen.getByText('Media Downloader')).toBeInTheDocument();
  });

  it('disables batch download when direct not ready', () => {
    mockCaps.directReady = false;
    mockCaps.mediaReady = true;
    render(<TopBar />);
    const chevron = screen.getAllByRole('button').find((b) => b.querySelector('.lucide-chevron-down'));
    expect(chevron).toBeDefined();
    if (chevron) fireEvent.click(chevron);
    expect(screen.getByText('Batch Download').closest('button')).toBeDisabled();
  });

  it('disables media options when media not ready', () => {
    mockCaps.directReady = true;
    mockCaps.mediaReady = false;
    render(<TopBar />);
    const chevron = screen.getAllByRole('button').find((b) => b.querySelector('.lucide-chevron-down'));
    expect(chevron).toBeDefined();
    if (chevron) fireEvent.click(chevron);
    expect(screen.getByText('Webpage Grabber').closest('button')).toBeDisabled();
    expect(screen.getByText('Media Downloader').closest('button')).toBeDisabled();
  });

  it('does nothing when both engines blocked on new download click (button disabled)', () => {
    mockCaps.directReady = false;
    mockCaps.mediaReady = false;
    mockCaps.error = 'No engines available';
    const addToast = vi.fn();
    mockStoreRef.current = makeStore({ addToast });
    render(<TopBar />);
    const disabledBtns = screen.getAllByTitle('No engines available');
    expect(disabledBtns.length).toBeGreaterThanOrEqual(1);
    const disabledBtn = disabledBtns[0];
    expect(disabledBtn).toBeDisabled();
    fireEvent.click(disabledBtn);
    expect(addToast).not.toHaveBeenCalled();
  });

  it('resume dropdown has resume selected and resume all items', () => {
    const task = makeTask({ status: 'paused' });
    const resumeTask = vi.fn();
    mockStoreRef.current = makeStore({ tasks: [task], selectedTaskId: 'task-1', resumeTask });
    render(<TopBar />);
    const chevrons = screen.getAllByRole('button').filter((b) => b.querySelector('.lucide-chevron-down'));
    if (chevrons[1]) fireEvent.click(chevrons[1]);
    expect(screen.getByText('Resume Selected')).toBeInTheDocument();
    expect(screen.getByText('Resume All')).toBeInTheDocument();
  });

  it('stop dropdown has stop selected and stop all items', () => {
    const task = makeTask({ status: 'downloading' });
    const pauseTask = vi.fn();
    mockStoreRef.current = makeStore({ tasks: [task], selectedTaskId: 'task-1', pauseTask });
    render(<TopBar />);
    const chevrons = screen.getAllByRole('button').filter((b) => b.querySelector('.lucide-chevron-down'));
    if (chevrons[2]) fireEvent.click(chevrons[2]);
    expect(screen.getByText('Stop Selected')).toBeInTheDocument();
    expect(screen.getByText('Stop All')).toBeInTheDocument();
  });

  it('delete dropdown has delete selected, delete all, delete completed', () => {
    const task = makeTask({ status: 'downloading' });
    mockStoreRef.current = makeStore({ tasks: [task], selectedTaskId: 'task-1' });
    render(<TopBar />);
    const chevrons = screen.getAllByRole('button').filter((b) => b.querySelector('.lucide-chevron-down'));
    const deleteChevron = chevrons[chevrons.length - 1];
    fireEvent.click(deleteChevron);
    expect(screen.getByText('Delete Selected')).toBeInTheDocument();
    expect(screen.getByText('Delete All')).toBeInTheDocument();
    expect(screen.getByText('Delete Completed')).toBeInTheDocument();
  });

  it('calls custom button action for openSettings', () => {
    const openDialog = vi.fn();
    const base = makeStore({ openDialog });
    base.settings = {
      ...base.settings,
      ui: {
        ...base.settings.ui,
        customButtons: [
          {
            id: 'settings-btn',
            label: 'My Settings',
            action: 'openSettings',
            icon: 'settings',
            enabled: true,
            display: 'full',
          },
        ],
      },
    };
    mockStoreRef.current = base;
    render(<TopBar />);
    fireEvent.click(screen.getByText('My Settings'));
    expect(openDialog).toHaveBeenCalledWith('settings');
  });

  it('toggles speed limiter via custom button action', () => {
    const updateSettings = vi.fn();
    const base = makeStore({ updateSettings });
    base.settings = {
      ...base.settings,
      connection: {
        ...base.settings.connection,
        speedLimiter: { enabled: true, maxSpeedKbs: 500 },
      },
      ui: {
        ...base.settings.ui,
        customButtons: [
          {
            id: 'speed-btn',
            label: 'Speed',
            action: 'toggleSpeedLimiter',
            icon: 'play',
            enabled: true,
            display: 'full',
          },
        ],
      },
    };
    mockStoreRef.current = base;
    render(<TopBar />);
    fireEvent.click(screen.getByText('Speed'));
    expect(updateSettings).toHaveBeenCalled();
  });

  it('toggles notifications via custom button', () => {
    const setIsNotificationsMuted = vi.fn();
    const base = makeStore({ setIsNotificationsMuted, isNotificationsMuted: false });
    base.settings = {
      ...base.settings,
      ui: {
        ...base.settings.ui,
        customButtons: [
          {
            id: 'notif-btn',
            label: 'Notifs',
            action: 'toggleNotifications',
            icon: 'bell',
            enabled: true,
            display: 'full',
          },
        ],
      },
    };
    mockStoreRef.current = base;
    render(<TopBar />);
    fireEvent.click(screen.getByText('Notifs'));
    expect(setIsNotificationsMuted).toHaveBeenCalledWith(true);
  });
});
