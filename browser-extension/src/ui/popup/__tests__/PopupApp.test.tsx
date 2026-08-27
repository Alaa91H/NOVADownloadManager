import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeRequest = vi.hoisted(() => vi.fn());

vi.mock('../../../i18n/react', () => ({
  useI18n: () => ({
    t: (key: string, replacements?: Record<string, string | number>) => {
      const map: Record<string, string> = {
        'popup.action.download': 'Download',
        'popup.action.downloadAll': 'All',
        'popup.action.close': 'Close',
        'popup.action.collapse': 'Collapse',
        'popup.message.cannotSend': 'Open NOVA or relink to restore sending.',
        'popup.scanning': 'Scanning…',
        'popup.handoffable': 'media',
        'popup.ready': 'Ready',
        'popup.needsCheck': 'Needs check',
        'popup.sentResult': 'Queued {count} item(s) for handoff.',
        'popup.noCandidates': 'No handoffable candidates to send.',
        'quality.resolveViaNOVA': 'Resolve via NOVA',
        'quality.header': 'Qualities ({n})',
        'quality.noneFromNOVA': 'NOVA did not report any qualities.',
        'quality.novaNotAccepted': 'NOVA did not accept the stream.',
        'quality.download': 'Download',
        'quality.sent': 'Sent',
        'taskActions.scan': 'Scan',
        'taskActions.sendSelected': 'Send selected',
        'taskActions.sendAll': 'Send all',
        'candidate.empty.title': 'No media found',
        'candidate.empty.help': 'Open a video page and scan again.',
      };
      return (map[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(replacements?.[name] ?? `{${name}}`));
    },
  }),
}));

vi.mock('../../runtime-request', () => ({
  runtimeRequest,
  messageFromError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

const watchUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const transientCdnUrl = 'https://r1---sn-a5meknls.googlevideo.com/videoplayback?itag=137&expire=1';

function youtubeCandidate() {
  return {
    id: 'youtube-137',
    url: transientCdnUrl,
    pageUrl: watchUrl,
    mediaType: 'video' as const,
    source: 'platform' as const,
    confidence: 95,
    createdAt: new Date().toISOString(),
    metadata: { videoId: 'dQw4w9WgXcQ', title: 'Example video', itag: '137' },
  };
}

function setupRuntime(options: { candidates?: ReturnType<typeof youtubeCandidate>[]; accepted?: boolean } = {}) {
  const candidates = options.candidates ?? [];
  const accepted = options.accepted ?? true;
  runtimeRequest.mockImplementation((message: Record<string, unknown>) => {
    switch (message.type) {
      case 'GET_BRIDGE_STATE':
        return Promise.resolve({ canSend: true, status: 'connected' });
      case 'GET_CANDIDATES':
        return Promise.resolve(candidates);
      case 'SCAN_PAGE':
        return Promise.resolve({ candidates, pageUrl: watchUrl });
      case 'ANALYZE_MEDIA':
        return Promise.resolve({
          ok: true,
          url: watchUrl,
          title: 'Example video',
          formats: [{
            formatId: '137',
            url: transientCdnUrl,
            label: '1080p',
            width: 1920,
            height: 1080,
            hasVideo: true,
            hasAudio: false,
          }],
        });
      case 'ADD_YTDLP_MEDIA':
        return Promise.resolve({ ok: true, accepted, message: accepted ? undefined : 'NOVA rejected the selected format.' });
      default:
        return Promise.resolve({});
    }
  });
}

function callsOf(type: string): Record<string, unknown>[] {
  return runtimeRequest.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === type);
}

describe('PopupApp (video capture)', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.resetModules();
    runtimeRequest.mockReset();
  });

  it('renders the compact empty state when no videos are captured on a non-video page', async () => {
    runtimeRequest.mockImplementation((message: Record<string, unknown>) => {
      if (message.type === 'GET_BRIDGE_STATE') return Promise.resolve({ canSend: false, status: 'offline' });
      if (message.type === 'GET_CANDIDATES') return Promise.resolve([]);
      if (message.type === 'SCAN_PAGE') return Promise.resolve({ candidates: [], pageUrl: 'https://example.test/' });
      return Promise.resolve({});
    });

    const { default: PopupApp } = await import('../PopupApp');
    render(<PopupApp />);

    await waitFor(() => expect(document.querySelector('.nova-popup-compact-empty')).toBeTruthy());
  });

  it('shows a managed resolve action for a YouTube page even when generic scanning finds no direct media candidate', async () => {
    setupRuntime();
    const { default: PopupApp } = await import('../PopupApp');
    render(<PopupApp />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolve via NOVA' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Resolve via NOVA' }));

    await waitFor(() => expect(callsOf('ANALYZE_MEDIA')).toHaveLength(1));
    expect(callsOf('ANALYZE_MEDIA')[0]).toMatchObject({ type: 'ANALYZE_MEDIA', url: watchUrl });
    expect(callsOf('DOWNLOAD_DIRECT')).toHaveLength(0);
    await waitFor(() => expect(document.querySelector('.nova-analyze-panel')).toBeTruthy());
  });

  it('routes a detected YouTube delivery URL through stable-page analysis instead of direct browser download', async () => {
    setupRuntime({ candidates: [youtubeCandidate()] });
    const { default: PopupApp } = await import('../PopupApp');
    render(<PopupApp />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(callsOf('ANALYZE_MEDIA')).toHaveLength(1));
    expect(callsOf('ANALYZE_MEDIA')[0]).toMatchObject({ type: 'ANALYZE_MEDIA', url: watchUrl });
    expect(callsOf('DOWNLOAD_DIRECT')).toHaveLength(0);
    await waitFor(() => expect(document.querySelector('.nova-analyze-panel')).toBeTruthy());
  });

  it('sends only a selected engine format and stable page URL after explicit analysis', async () => {
    setupRuntime({ candidates: [youtubeCandidate()] });
    const { default: PopupApp } = await import('../PopupApp');
    render(<PopupApp />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(document.querySelector('.nova-analyze-panel .nova-quality-download')).toBeTruthy());
    fireEvent.click(document.querySelector('.nova-analyze-panel .nova-quality-download')!);

    await waitFor(() => expect(callsOf('ADD_YTDLP_MEDIA')).toHaveLength(1));
    expect(callsOf('ADD_YTDLP_MEDIA')[0]).toMatchObject({
      type: 'ADD_YTDLP_MEDIA',
      url: watchUrl,
      pageUrl: watchUrl,
      selectedFormat: { formatId: '137' },
      drmProtected: false,
    });
    expect(callsOf('DOWNLOAD_DIRECT')).toHaveLength(0);
    await waitFor(() => expect(screen.getByText('Queued 1 item(s) for handoff.')).toBeTruthy());
  });

  it('serializes rapid YouTube resolve clicks while the managed analysis is pending', async () => {
    let resolveAnalysis: ((value: Record<string, unknown>) => void) | undefined;
    setupRuntime();
    runtimeRequest.mockImplementation((message: Record<string, unknown>) => {
      if (message.type === 'GET_BRIDGE_STATE') return Promise.resolve({ canSend: true, status: 'connected' });
      if (message.type === 'GET_CANDIDATES') return Promise.resolve([]);
      if (message.type === 'SCAN_PAGE') return Promise.resolve({ candidates: [], pageUrl: watchUrl });
      if (message.type === 'ANALYZE_MEDIA') {
        return new Promise((resolve) => { resolveAnalysis = resolve; });
      }
      return Promise.resolve({});
    });
    const { default: PopupApp } = await import('../PopupApp');
    render(<PopupApp />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolve via NOVA' })).toBeTruthy());
    const resolveButton = screen.getByRole('button', { name: 'Resolve via NOVA' });
    fireEvent.click(resolveButton);
    fireEvent.click(resolveButton);

    await waitFor(() => expect(callsOf('ANALYZE_MEDIA')).toHaveLength(1));
    await waitFor(() => expect(document.querySelector('.nova-popup-mini-mode')?.getAttribute('aria-busy')).toBe('true'));
    resolveAnalysis?.({
      ok: true,
      url: watchUrl,
      title: 'Example video',
      formats: [{ formatId: '137', url: transientCdnUrl, label: '1080p', hasVideo: true, hasAudio: false }],
    });
    await waitFor(() => expect(document.querySelector('.nova-analyze-panel')).toBeTruthy());
  });

  it('does not analyze a transient YouTube delivery URL when a stable page URL is unavailable', async () => {
    setupRuntime({ candidates: [{ ...youtubeCandidate(), pageUrl: undefined }] });
    const { default: PopupApp } = await import('../PopupApp');
    render(<PopupApp />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(screen.getByText('NOVA did not report any qualities.')).toBeTruthy());
    expect(callsOf('ANALYZE_MEDIA')).toHaveLength(0);
    expect(callsOf('DOWNLOAD_DIRECT')).toHaveLength(0);
  });

  it('does not offer a download when managed analysis marks media as DRM-protected', async () => {
    setupRuntime();
    runtimeRequest.mockImplementation((message: Record<string, unknown>) => {
      if (message.type === 'GET_BRIDGE_STATE') return Promise.resolve({ canSend: true, status: 'connected' });
      if (message.type === 'GET_CANDIDATES') return Promise.resolve([]);
      if (message.type === 'SCAN_PAGE') return Promise.resolve({ candidates: [], pageUrl: watchUrl });
      if (message.type === 'ANALYZE_MEDIA') return Promise.resolve({ ok: true, url: watchUrl, drmProtected: true, formats: [] });
      return Promise.resolve({});
    });
    const { default: PopupApp } = await import('../PopupApp');
    render(<PopupApp />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolve via NOVA' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Resolve via NOVA' }));

    await waitFor(() => expect(screen.getByText('NOVA did not report any qualities.')).toBeTruthy());
    expect(callsOf('ADD_YTDLP_MEDIA')).toHaveLength(0);
  });

  it('does not report success when NOVA rejects the selected managed-media format', async () => {
    setupRuntime({ candidates: [youtubeCandidate()], accepted: false });
    const { default: PopupApp } = await import('../PopupApp');
    render(<PopupApp />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(document.querySelector('.nova-analyze-panel .nova-quality-download')).toBeTruthy());
    fireEvent.click(document.querySelector('.nova-analyze-panel .nova-quality-download')!);

    await waitFor(() => expect(screen.getByText('NOVA rejected the selected format.')).toBeTruthy());
    expect(screen.queryByText('Queued 1 item(s) for handoff.')).toBeNull();
    expect(document.querySelector('.nova-analyze-panel .nova-quality-download')?.getAttribute('data-sent')).toBeNull();
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  });
});
