import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

vi.mock('../../../api/novaClient', () => ({
  novaClient: {
    checkFfmpeg: vi.fn().mockResolvedValue({ available: true }),
    probeMedia: vi.fn().mockRejectedValue(new Error('No URL provided')),
    probePlaylist: vi.fn().mockRejectedValue(new Error('No URL provided')),
  },
}));

vi.mock('../../../api/tauriClient', () => ({
  tauriClient: {
    getDownloadsDir: vi.fn().mockResolvedValue('/downloads'),
    validateVpnRoute: vi.fn().mockResolvedValue({ ok: true, message: '' }),
    showDirectoryPicker: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../../capabilities/EngineCapabilityContext', () => ({
  useEngineCapabilities: () => mockEngineCapabilities,
}));

vi.mock('../../../utils/clipboard', () => ({
  clearClipboardIfTextMatches: vi.fn(),
}));

import { YoutubeDownloadDialog } from '../YoutubeDownloadDialog';

const mockEngineCapabilities = {
  mediaReady: true,
  directReady: true,
  postProcessingReady: true,
  mediaBlockedReason: () => null,
  supportsMediaOption: () => true,
  sanitizeMediaOptions: (opts: Record<string, unknown>) => opts,
  supportsDirectOption: () => true,
  directOptionKeys: new Set(['segmented', 'range', 'referer', 'userAgent', 'proxy', 'retryCount', 'timeoutSec']),
  directBlockedReason: () => null,
};

const { storeRef, mockCloseDialog, mockAddTask, mockAddToast, mockOpenDialog } = vi.hoisted(() => {
  const mockCloseDialog = vi.fn();
  const mockAddTask = vi.fn().mockResolvedValue({ id: 'new-task' });
  const mockAddToast = vi.fn();
  const mockOpenDialog = vi.fn();
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  return { storeRef, mockCloseDialog, mockAddTask, mockAddToast, mockOpenDialog };
});

describe('YoutubeDownloadDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      dialog: { active: 'youtubeDownload', payload: null },
      closeDialog: mockCloseDialog,
      addTask: mockAddTask,
      addToast: mockAddToast,
      openDialog: mockOpenDialog,
      settings: {
        extra: {
          userAgent: '',
          preventClipboardHistory: false,
          downloadSubtitles: false,
          subtitleLanguage: '',
          ffmpegPath: '',
          vpnEnabled: false,
          vpnKillSwitch: false,
          vpnMode: 'proxy',
          vpnProxyUrl: '',
          vpnBindAddress: '',
          browserPairingToken: '',
        },
        connection: {
          enableProxy: false,
          proxyHost: '',
          proxyPort: 0,
          maxConnections: 8,
          speedLimiter: { enabled: false, maxSpeedKbs: 0 },
        },
        saveAndCategories: {
          defaultFolder: '/downloads',
          categoryFolders: {},
        },
      },
      t: (k: string) => {
        const map: Record<string, string> = {
          btn_cancel: 'Cancel',
        };
        return map[k] || k;
      },
    };
  });

  it('renders media downloader title', () => {
    render(<YoutubeDownloadDialog />);
    expect(screen.getByText('Media Downloader')).toBeInTheDocument();
  });

  it('renders URL input field', () => {
    render(<YoutubeDownloadDialog />);
    expect(screen.getByText('Media URL (Video or Playlist URL)')).toBeInTheDocument();
  });

  it('renders Cancel and Start Download buttons', () => {
    render(<YoutubeDownloadDialog />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Start Download')).toBeInTheDocument();
  });

  it('updates URL on input change', () => {
    render(<YoutubeDownloadDialog />);
    const input = document.getElementById('yt-url') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com/video' } });
    expect(input.value).toBe('https://example.com/video');
  });

  it('shows error toast when starting download with empty URL', () => {
    render(<YoutubeDownloadDialog />);
    fireEvent.click(screen.getByText('Start Download'));
    expect(mockAddToast).toHaveBeenCalledWith('error', 'Invalid Link', expect.any(String));
  });

  it('shows media engine unavailable error when media is not ready', () => {
    mockEngineCapabilities.mediaReady = false;
    mockEngineCapabilities.mediaBlockedReason = () => 'yt-dlp is not installed';
    render(<YoutubeDownloadDialog />);
    expect(screen.getByText(/yt-dlp is not ready/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Start Download'));
    expect(mockAddToast).toHaveBeenCalledWith('error', 'Media engine unavailable', 'yt-dlp is not installed');
  });

  it('shows FFmpeg unavailable banner when post-processing is not ready', () => {
    mockEngineCapabilities.postProcessingReady = false;
    render(<YoutubeDownloadDialog />);
    expect(screen.getByText(/FFmpeg is not ready/)).toBeInTheDocument();
  });

  it('shows no banner when both engines are ready', () => {
    mockEngineCapabilities.mediaReady = true;
    mockEngineCapabilities.postProcessingReady = true;
    render(<YoutubeDownloadDialog />);
    expect(screen.queryByText(/yt-dlp is not ready/)).not.toBeInTheDocument();
    expect(screen.queryByText(/FFmpeg is not ready/)).not.toBeInTheDocument();
  });

  it('renders video and audio mode buttons', () => {
    render(<YoutubeDownloadDialog />);
    expect(screen.getByText('Video')).toBeInTheDocument();
    expect(screen.getByText('Audio')).toBeInTheDocument();
  });

  it('switches to audio mode when audio button clicked', () => {
    render(<YoutubeDownloadDialog />);
    fireEvent.click(screen.getByText('Audio'));
    expect(screen.getByText('Audio Format')).toBeInTheDocument();
  });

  it('renders advanced settings section', () => {
    render(<YoutubeDownloadDialog />);
    expect(screen.getByText(/Advanced Options/)).toBeInTheDocument();
  });

  it('calls closeDialog on cancel', () => {
    render(<YoutubeDownloadDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('renders save directory input', () => {
    render(<YoutubeDownloadDialog />);
    const inputs = screen.getAllByDisplayValue('/downloads');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });

  it('renders output template input', () => {
    render(<YoutubeDownloadDialog />);
    const tmplInput = screen.getByDisplayValue('%(title)s.%(ext)s');
    expect(tmplInput).toBeInTheDocument();
  });

  it('renders subtitle options', () => {
    render(<YoutubeDownloadDialog />);
    fireEvent.click(screen.getByText(/Advanced Options/));
    expect(screen.getByText('Download Subtitles')).toBeInTheDocument();
  });

  it('renders format selector section', () => {
    render(<YoutubeDownloadDialog />);
    expect(screen.getByText(/Format Selector Override/)).toBeInTheDocument();
  });

  it('shows probing indicator when URL entered', async () => {
    render(<YoutubeDownloadDialog />);
    const input = document.getElementById('yt-url') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://youtube.com/watch?v=test' } });
    const fetchText = await screen.findByText(/Fetching available formats/);
    expect(fetchText).toBeInTheDocument();
  });

  it('renders Cancel button text via translation', () => {
    storeRef.current = {
      ...storeRef.current,
      t: (k: string) => {
        if (k === 'btn_cancel') return 'Ighlaq';
        return k;
      },
    };
    render(<YoutubeDownloadDialog />);
    expect(screen.getByText('Ighlaq')).toBeInTheDocument();
  });

  it('restores engine capabilities after test', () => {
    mockEngineCapabilities.mediaReady = true;
    mockEngineCapabilities.postProcessingReady = true;
  });
});
