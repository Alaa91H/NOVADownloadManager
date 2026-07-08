import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngineCapabilityProvider, useEngineCapabilities } from '../EngineCapabilityContext';

const TestConsumer: React.FC = () => {
  const caps = useEngineCapabilities();
  return (
    <div>
      <div data-testid="loading">{String(caps.loading)}</div>
      <div data-testid="error">{caps.error || 'none'}</div>
      <div data-testid="directReady">{String(caps.directReady)}</div>
      <div data-testid="mediaReady">{String(caps.mediaReady)}</div>
      <div data-testid="ffmpegReady">{String(caps.ffmpegReady)}</div>
      <div data-testid="directEngineId">{caps.directEngineId}</div>
      <div data-testid="mediaEngineId">{caps.mediaEngineId}</div>
      <div data-testid="postProcessorId">{caps.postProcessorId}</div>
      <div data-testid="directProtocols">{caps.directProtocols.join(',')}</div>
      <div data-testid="postProcessingReady">{String(caps.postProcessingReady)}</div>
      <div data-testid="streamResolverReady">{String(caps.streamResolverReady)}</div>
      <div data-testid="directBlocked">{caps.directBlockedReason('http://example.com') || 'allowed'}</div>
      <div data-testid="mediaBlocked">{caps.mediaBlockedReason() || 'allowed'}</div>
      <div data-testid="supportsDirectOption">{String(caps.supportsDirectOption('userAgent'))}</div>
      <div data-testid="supportsMediaOption">{String(caps.supportsMediaOption('quality'))}</div>
      <div data-testid="supportsDirectProtocol">{String(caps.supportsDirectProtocol('http'))}</div>
      <div data-testid="supportsStreamCandidate">{String(caps.supportsStreamCandidate('hls', '', ''))}</div>
    </div>
  );
};

const mockNovaClient = vi.hoisted(() => ({
  engineCapabilities: vi.fn(),
}));

vi.mock('../../api/novaClient', () => ({
  novaClient: mockNovaClient,
}));

describe('EngineCapabilityProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading initially', () => {
    mockNovaClient.engineCapabilities.mockReturnValue(new Promise(() => {}));
    render(
      <EngineCapabilityProvider>
        <TestConsumer />
      </EngineCapabilityProvider>,
    );
    expect(screen.getByTestId('loading').textContent).toBe('true');
  });

  it('renders capabilities when loaded', async () => {
    mockNovaClient.engineCapabilities.mockResolvedValue({
      directReady: true,
      mediaReady: true,
      engines: {
        ffmpeg: { available: true },
        libcurlMulti: {
          protocols: ['http', 'https', 'ftp'],
          supportedDirectOptionKeys: ['userAgent', 'referer', 'headers', 'cookies', 'proxy', 'speedLimitKbs'],
        },
        ytdlp: {
          available: true,
          supportedMediaOptionKeys: ['quality', 'formatSelector', 'subtitles'],
        },
      },
      routing: {
        directHttpHttpsFtp: 'libcurl-multi',
        webMediaAndPlaylists: 'yt-dlp',
        mergeRemuxExtractSubtitles: 'ffmpeg',
      },
      directProtocols: ['http', 'https', 'ftp'],
      postProcessingReady: true,
      streamResolverReady: true,
    });

    render(
      <EngineCapabilityProvider>
        <TestConsumer />
      </EngineCapabilityProvider>,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('directReady').textContent).toBe('true');
    expect(screen.getByTestId('mediaReady').textContent).toBe('true');
    expect(screen.getByTestId('ffmpegReady').textContent).toBe('true');
    expect(screen.getByTestId('directEngineId').textContent).toBe('libcurl-multi');
    expect(screen.getByTestId('mediaEngineId').textContent).toBe('yt-dlp');
    expect(screen.getByTestId('postProcessorId').textContent).toBe('ffmpeg');
    expect(screen.getByTestId('directProtocols').textContent).toBe('http,https,ftp');
    expect(screen.getByTestId('postProcessingReady').textContent).toBe('true');
    expect(screen.getByTestId('streamResolverReady').textContent).toBe('true');
    expect(screen.getByTestId('directBlocked').textContent).toBe('allowed');
    expect(screen.getByTestId('mediaBlocked').textContent).toBe('allowed');
    expect(screen.getByTestId('supportsDirectOption').textContent).toBe('true');
    expect(screen.getByTestId('supportsMediaOption').textContent).toBe('true');
    expect(screen.getByTestId('supportsDirectProtocol').textContent).toBe('true');
    expect(screen.getByTestId('supportsStreamCandidate').textContent).toBe('true');
  });

  it('shows error when engine capabilities fail', async () => {
    mockNovaClient.engineCapabilities.mockRejectedValue(new Error('Network error'));

    render(
      <EngineCapabilityProvider>
        <TestConsumer />
      </EngineCapabilityProvider>,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId('error').textContent).not.toBe('none');
    });

    expect(screen.getByTestId('error').textContent).toContain('Network error');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('directReady').textContent).toBe('false');
    expect(screen.getByTestId('mediaReady').textContent).toBe('false');
  });

  it('returns fallback when used outside provider', () => {
    render(<TestConsumer />);
    expect(screen.getByTestId('loading').textContent).toBe('true');
    expect(screen.getByTestId('error').textContent).toContain('EngineCapabilityProvider is not mounted');
  });

  it('supports sanitizeDirectOptions filtering', async () => {
    mockNovaClient.engineCapabilities.mockResolvedValue({
      directReady: true,
      mediaReady: true,
      engines: {
        libcurlMulti: {
          supportedDirectOptionKeys: ['userAgent', 'referer'],
          protocols: ['http', 'https'],
        },
      },
    });

    function TestComponent() {
      const caps = useEngineCapabilities();
      if (caps.loading) return <div data-testid="caps-loading">true</div>;

      const sanitized = caps.sanitizeDirectOptions({
        userAgent: 'test',
        referer: 'http://example.com',
        proxy: 'http://proxy:8080',
      });

      return (
        <div>
          <div data-testid="has-userAgent">{String('userAgent' in sanitized)}</div>
          <div data-testid="has-referer">{String('referer' in sanitized)}</div>
          <div data-testid="has-proxy">{String('proxy' in sanitized)}</div>
        </div>
      );
    }

    render(
      <EngineCapabilityProvider>
        <TestComponent />
      </EngineCapabilityProvider>,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId('has-userAgent').textContent).toBe('true');
    });
    expect(screen.getByTestId('has-referer').textContent).toBe('true');
    expect(screen.getByTestId('has-proxy').textContent).toBe('false');
  });

  it('reports directBlockedReason when direct not ready', async () => {
    mockNovaClient.engineCapabilities.mockResolvedValue({
      directReady: false,
      mediaReady: false,
    });

    render(
      <EngineCapabilityProvider>
        <TestConsumer />
      </EngineCapabilityProvider>,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('directBlocked').textContent).toContain('not ready');
    expect(screen.getByTestId('mediaBlocked').textContent).toContain('not ready');
  });
});
