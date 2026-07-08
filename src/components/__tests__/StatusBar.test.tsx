import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockStore } from '../../test/mockStore';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));

const mockNovaClient = vi.hoisted(() => ({
  updateTelegramConfig: vi.fn().mockResolvedValue(undefined),
  testTelegram: vi.fn().mockResolvedValue({ ok: true }),
  sendTelegramFile: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../api/novaClient', () => ({
  novaClient: mockNovaClient,
}));

const mockCaps = vi.hoisted(() => ({
  loading: false,
  error: null,
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
  sanitizeDirectOptions: vi.fn((o) => o),
  sanitizeMediaOptions: vi.fn((o) => o),
  directBlockedReason: vi.fn(() => null),
  mediaBlockedReason: vi.fn(() => null),
}));

vi.mock('../../capabilities/EngineCapabilityContext', () => ({
  useEngineCapabilities: () => mockCaps,
}));

vi.mock('../../state/appStore', () => ({
  useAppStore: () => mockStoreRef.current,
}));

import { StatusBar } from '../StatusBar';

const mockStoreRef = { current: createMockStore() };

describe('StatusBar', () => {
  beforeEach(() => {
    mockStoreRef.current = createMockStore({
      tasks: [],
      settings: {
        ...createMockStore().settings,
        ui: {
          ...createMockStore().settings.ui,
          statusBar: {
            speed: { visible: true },
            counts: { visible: true },
            downloaded: { visible: true },
            daemon: { visible: true },
            browser: { visible: true },
            telegram: { visible: true },
            clipboard: { visible: true },
            speedLimiter: { visible: true },
            notifications: { visible: true },
          },
        },
      },
    });
    mockCaps.loading = false;
    mockCaps.directReady = true;
    mockCaps.mediaReady = true;
    mockCaps.ffmpegReady = true;
    mockCaps.directBlockedReason = vi.fn(() => null);
    mockCaps.mediaBlockedReason = vi.fn(() => null);
    vi.clearAllMocks();
  });

  it('renders speed indicator', () => {
    render(<StatusBar />);
    expect(screen.getByTitle('Download speed')).toBeInTheDocument();
  });

  it('renders active and total counts', () => {
    mockStoreRef.current = createMockStore({
      tasks: [
        { id: 't1', status: 'downloading', speedBytesPerSec: 102400, downloadedBytes: 500, sizeBytes: 1000 } as any,
        { id: 't2', status: 'completed', speedBytesPerSec: 0, downloadedBytes: 1000, sizeBytes: 1000 } as any,
      ],
    });
    render(<StatusBar />);
    expect(screen.getByTitle('Active and total download counts')).toBeInTheDocument();
  });

  it('renders daemon status button in normal mode', () => {
    mockStoreRef.current = createMockStore({ isDegradedMode: false });
    render(<StatusBar />);
    expect(screen.getByTitle('Daemon is connected')).toBeInTheDocument();
  });

  it('shows degraded mode warning', () => {
    mockStoreRef.current = createMockStore({ isDegradedMode: true });
    render(<StatusBar />);
    expect(screen.getByTitle('Daemon is disconnected — some features unavailable')).toBeInTheDocument();
  });

  it('shows degraded alert even when daemon status hidden', () => {
    mockStoreRef.current = createMockStore({
      isDegradedMode: true,
      settings: {
        ...createMockStore().settings,
        ui: {
          ...createMockStore().settings.ui,
          statusBar: {
            speed: { visible: true },
            counts: { visible: true },
            downloaded: { visible: true },
            daemon: { visible: false },
            browser: { visible: true },
            telegram: { visible: true },
            clipboard: { visible: true },
            speedLimiter: { visible: true },
            notifications: { visible: true },
          },
        },
      },
    });
    render(<StatusBar />);
    expect(screen.getByTitle('Daemon is disconnected — some features unavailable')).toBeInTheDocument();
  });

  it('calls addToast with degraded info on daemon click in degraded mode', () => {
    const addToast = vi.fn();
    mockStoreRef.current = createMockStore({ isDegradedMode: true, addToast });
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle('Daemon is disconnected — some features unavailable'));
    expect(addToast).toHaveBeenCalledWith('warning', 'Degraded Mode', 'Daemon is offline');
  });

  it('shows direct engine indicator as ready', () => {
    mockCaps.directReady = true;
    render(<StatusBar />);
    expect(screen.getByTitle('Engine ready for direct downloads')).toBeInTheDocument();
  });

  it('shows direct engine indicator as unavailable', () => {
    mockCaps.directReady = false;
    (mockCaps.directBlockedReason as ReturnType<typeof vi.fn>).mockReturnValue('Engine not installed');
    render(<StatusBar />);
    expect(screen.getByTitle('Engine not installed')).toBeInTheDocument();
  });

  it('shows media engine indicator as ready', () => {
    mockCaps.mediaReady = true;
    render(<StatusBar />);
    expect(screen.getByTitle('Engine ready for media downloads')).toBeInTheDocument();
  });

  it('shows media engine indicator as unavailable', () => {
    mockCaps.mediaReady = false;
    (mockCaps.mediaBlockedReason as ReturnType<typeof vi.fn>).mockReturnValue('yt-dlp not found');
    render(<StatusBar />);
    expect(screen.getByTitle('yt-dlp not found')).toBeInTheDocument();
  });

  it('shows ffmpeg ready dot', () => {
    mockCaps.ffmpegReady = true;
    mockCaps.mediaReady = true;
    render(<StatusBar />);
    expect(screen.getByTitle('FFmpeg is ready for post-processing')).toBeInTheDocument();
  });

  it('shows ffmpeg unavailable dot when media ready but ffmpeg not', () => {
    mockCaps.ffmpegReady = false;
    mockCaps.mediaReady = true;
    render(<StatusBar />);
    expect(screen.getByTitle('FFmpeg is not available')).toBeInTheDocument();
  });

  it('hides engine indicators when caps loading', () => {
    mockCaps.loading = true;
    render(<StatusBar />);
    expect(screen.queryByTitle('Engine ready for direct downloads')).not.toBeInTheDocument();
  });

  it('shows browser integration as connected', () => {
    mockStoreRef.current = createMockStore({
      settings: {
        ...createMockStore().settings,
        general: {
          ...createMockStore().settings.general,
          integrateWithBrowsers: { chrome: true, firefox: false, edge: false },
        },
      },
    });
    render(<StatusBar />);
    expect(screen.getByTitle('Browser Integration')).toBeInTheDocument();
  });

  it('shows telegram as configured', () => {
    mockStoreRef.current = createMockStore({
      settings: {
        ...createMockStore().settings,
        extra: {
          ...createMockStore().settings.extra,
          tgEnabled: true,
          tgBotToken: 'token123',
          tgChatId: '12345',
        },
      },
    });
    render(<StatusBar />);
    expect(screen.getByTitle('Telegram is connected')).toBeInTheDocument();
  });

  it('shows telegram as disconnected when not configured', () => {
    mockStoreRef.current = createMockStore({
      settings: {
        ...createMockStore().settings,
        extra: {
          ...createMockStore().settings.extra,
          tgEnabled: false,
          tgBotToken: '',
          tgChatId: '',
        },
      },
    });
    render(<StatusBar />);
    expect(screen.getByTitle('Telegram is not configured')).toBeInTheDocument();
  });

  it('opens settings on telegram click', () => {
    const openDialog = vi.fn();
    mockStoreRef.current = createMockStore({ openDialog });
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle('Telegram is not configured'));
    expect(openDialog).toHaveBeenCalledWith('settings', { tab: 'integrations_automation', subTab: 'telegram' });
  });

  it('shows telegram context menu on right-click', () => {
    render(<StatusBar />);
    fireEvent.contextMenu(screen.getByTitle('Telegram is not configured'));
    expect(screen.getByText('Telegram Controls')).toBeInTheDocument();
  });

  it('toggles telegram enable from context menu', () => {
    const updateSettings = vi.fn();
    mockStoreRef.current = createMockStore({ updateSettings });
    render(<StatusBar />);
    fireEvent.contextMenu(screen.getByTitle('Telegram is not configured'));
    fireEvent.click(screen.getByText('Enable Telegram'));
    expect(updateSettings).toHaveBeenCalled();
  });

  it('shows clipboard monitor as on', () => {
    mockStoreRef.current = createMockStore({
      settings: {
        ...createMockStore().settings,
        general: {
          ...createMockStore().settings.general,
          monitorClipboard: true,
        },
      },
    });
    render(<StatusBar />);
    expect(screen.getByTitle('Clipboard monitoring is on')).toBeInTheDocument();
  });

  it('shows clipboard monitor as off', () => {
    mockStoreRef.current = createMockStore({
      settings: {
        ...createMockStore().settings,
        general: {
          ...createMockStore().settings.general,
          monitorClipboard: false,
        },
      },
    });
    render(<StatusBar />);
    expect(screen.getByTitle('Clipboard monitoring is off')).toBeInTheDocument();
  });

  it('toggles clipboard monitoring on click', () => {
    const updateSettings = vi.fn();
    mockStoreRef.current = createMockStore({
      updateSettings,
      settings: {
        ...createMockStore().settings,
        general: {
          ...createMockStore().settings.general,
          monitorClipboard: false,
        },
      },
    });
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle('Clipboard monitoring is off'));
    expect(updateSettings).toHaveBeenCalled();
  });

  it('shows speed limiter button', () => {
    render(<StatusBar />);
    expect(screen.getByTitle('Speed Limiter')).toBeInTheDocument();
  });

  it('opens speed menu on speed limiter click', () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle('Speed Limiter'));
    expect(screen.getByText('Speed Limit')).toBeInTheDocument();
  });

  it('shows speed presets in speed menu', () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle('Speed Limiter'));
    expect(screen.getByText('500 KB/s')).toBeInTheDocument();
    expect(screen.getByText('1 MB/s')).toBeInTheDocument();
    expect(screen.getByText('5 MB/s')).toBeInTheDocument();
    expect(screen.getByText('10 MB/s')).toBeInTheDocument();
  });

  it('applies speed preset from menu', () => {
    const updateSettings = vi.fn();
    mockStoreRef.current = createMockStore({ updateSettings });
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle('Speed Limiter'));
    fireEvent.click(screen.getByText('5 MB/s'));
    expect(updateSettings).toHaveBeenCalled();
  });

  it('shows notification bell as active', () => {
    mockStoreRef.current = createMockStore({ isNotificationsMuted: false });
    render(<StatusBar />);
    expect(screen.getByTitle('Notifications active — click to mute')).toBeInTheDocument();
  });

  it('shows notification bell as muted', () => {
    mockStoreRef.current = createMockStore({ isNotificationsMuted: true });
    render(<StatusBar />);
    expect(screen.getByTitle('Notifications are muted — click to unmute')).toBeInTheDocument();
  });

  it('toggles notifications on bell click', () => {
    const setIsNotificationsMuted = vi.fn();
    const addToast = vi.fn();
    mockStoreRef.current = createMockStore({ setIsNotificationsMuted, addToast, isNotificationsMuted: false });
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle('Notifications active — click to mute'));
    expect(setIsNotificationsMuted).toHaveBeenCalledWith(true);
  });

  it('shows minimized progress bar when active', () => {
    mockStoreRef.current = createMockStore({
      activeProgressMinimizedToTaskbar: true,
      minimizedProgressTask: { id: 't1', name: 'test.zip', sizeBytes: 1000, downloadedBytes: 500 },
      tasks: [{ id: 't1', name: 'test.zip', sizeBytes: 1000, downloadedBytes: 500 }],
    });
    render(<StatusBar />);
    expect(screen.getByTitle('Restore progress window')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('opens progress dialog on minimized bar click', () => {
    const openDialog = vi.fn();
    mockStoreRef.current = createMockStore({
      openDialog,
      activeProgressMinimizedToTaskbar: true,
      minimizedProgressTask: { id: 't1', name: 'test.zip', sizeBytes: 1000, downloadedBytes: 500 },
      tasks: [{ id: 't1', name: 'test.zip', sizeBytes: 1000, downloadedBytes: 500 }],
    });
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle('Restore progress window'));
    expect(openDialog).toHaveBeenCalledWith('activeProgress', expect.objectContaining({ id: 't1' }));
  });

  it('hides individual status items when visibility is false', () => {
    mockStoreRef.current = createMockStore({
      settings: {
        ...createMockStore().settings,
        ui: {
          ...createMockStore().settings.ui,
          statusBar: {
            speed: { visible: false },
            counts: { visible: false },
            downloaded: { visible: false },
            daemon: { visible: false },
            browser: { visible: false },
            telegram: { visible: false },
            clipboard: { visible: false },
            speedLimiter: { visible: false },
            notifications: { visible: false },
          },
        },
      },
    });
    render(<StatusBar />);
    expect(screen.queryByTitle('Download speed')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Speed Limiter')).not.toBeInTheDocument();
  });

  it('calls novaClient.testTelegram from context menu', async () => {
    mockStoreRef.current = createMockStore({
      settings: {
        ...createMockStore().settings,
        extra: {
          ...createMockStore().settings.extra,
          tgEnabled: true,
          tgBotToken: 'token',
          tgChatId: '12345',
        },
      },
    });
    render(<StatusBar />);
    fireEvent.contextMenu(screen.getByTitle('Telegram is connected'));
    fireEvent.click(screen.getByText('Send Test Notification'));
    expect(mockNovaClient.updateTelegramConfig).toHaveBeenCalled();
    expect(mockNovaClient.testTelegram).toHaveBeenCalled();
  });

  it('shows speed limiter enabled state with amber color', () => {
    mockStoreRef.current = createMockStore({
      settings: {
        ...createMockStore().settings,
        connection: {
          ...createMockStore().settings.connection,
          speedLimiter: { enabled: true, maxSpeedKbs: 1024 },
        },
      },
    });
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle('Speed Limiter'));
    expect(screen.getByText('Speed Limit')).toBeInTheDocument();
    expect(screen.getByText(/1 MB\/s/)).toBeInTheDocument();
  });

  it('toggles speed limiter enable from speed menu', () => {
    const updateSettings = vi.fn();
    mockStoreRef.current = createMockStore({
      updateSettings,
      settings: {
        ...createMockStore().settings,
        connection: {
          ...createMockStore().settings.connection,
          speedLimiter: { enabled: false, maxSpeedKbs: 500 },
        },
      },
    });
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle('Speed Limiter'));
    fireEvent.click(screen.getByText('Enable Limiter'));
    expect(updateSettings).toHaveBeenCalled();
  });
});
