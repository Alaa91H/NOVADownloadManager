/* src/dialogs/settings/sections/EngineManagement.tsx */
import React, { useState, useEffect, useCallback } from 'react';
import { Download, CheckCircle, AlertCircle, RefreshCw, ExternalLink, Loader2, Activity, Code, Video } from 'lucide-react';
import { useToastActions } from '../../../store/selectors';
import { novaClient } from '../../../api/novaClient';
import { useEngineCapabilities } from '../../../capabilities/EngineCapabilityContext';

type EngineStatus = 'idle' | 'checking' | 'downloading' | 'verifying' | 'done' | 'error';

interface EngineState {
  status: EngineStatus;
  available: boolean;
  version: string;
  path: string;
  latestVersion: string;
  updateAvailable: boolean;
  error: string;
}

const initialEngineState: EngineState = {
  status: 'idle',
  available: false,
  version: '',
  path: '',
  latestVersion: '',
  updateAvailable: false,
  error: '',
};

export const EngineManagement: React.FC = () => {
  const { addToast } = useToastActions();
  const engineCapabilities = useEngineCapabilities();

  const [ytdlp, setYtdlp] = useState<EngineState>(initialEngineState);
  const [ffmpeg, setFfmpeg] = useState<EngineState>(initialEngineState);

  const checkEngineStatus = useCallback(async () => {
    const ytdlpResult = await novaClient.verifyEngine('ytdlp').catch(() => null);
    if (ytdlpResult?.ok) {
      setYtdlp((prev) => ({
        ...prev,
        available: ytdlpResult.available,
        version: ytdlpResult.version || '',
        path: ytdlpResult.path || '',
      }));
    }

    const ffmpegResult = await novaClient.verifyEngine('ffmpeg').catch(() => null);
    if (ffmpegResult?.ok) {
      setFfmpeg((prev) => ({
        ...prev,
        available: ffmpegResult.available,
        version: ffmpegResult.version || '',
        path: ffmpegResult.path || '',
      }));
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => {
      void checkEngineStatus();
    }, 0);
    return () => { clearTimeout(timeout); };
  }, [checkEngineStatus]);

  const handleDownload = async (engine: 'ytdlp' | 'ffmpeg') => {
    const setter = engine === 'ytdlp' ? setYtdlp : setFfmpeg;
    setter((prev) => ({ ...prev, status: 'downloading', error: '' }));

    try {
      const result = await novaClient.downloadEngine(engine);
      if (result.ok) {
        setter((prev) => ({
          ...prev,
          status: 'done',
          available: true,
          version: result.version || '',
          path: result.path || '',
        }));
        addToast('success', 'Engine Downloaded', `${engine === 'ytdlp' ? 'yt-dlp' : 'FFmpeg'} was downloaded successfully.`);
        void checkEngineStatus();
      } else {
        setter((prev) => ({ ...prev, status: 'error', error: result.error || 'Unknown error' }));
        addToast('error', 'Download Failed', result.error || 'Could not download the engine.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setter((prev) => ({ ...prev, status: 'error', error: msg }));
      addToast('error', 'Download Failed', msg);
    }
  };

  const handleVerify = async (engine: 'ytdlp' | 'ffmpeg') => {
    const setter = engine === 'ytdlp' ? setYtdlp : setFfmpeg;
    setter((prev) => ({ ...prev, status: 'verifying', error: '' }));

    try {
      const result = await novaClient.verifyEngine(engine);
      if (result.ok) {
        setter((prev) => ({
          ...prev,
          status: 'done',
          available: result.available,
          version: result.version || '',
          path: result.path || '',
          error: result.available ? '' : 'Binary not found',
        }));
        addToast(
          result.available ? 'success' : 'warning',
          'Verification Complete',
          result.available
            ? `${engine === 'ytdlp' ? 'yt-dlp' : 'FFmpeg'} v${result.version ?? ''} is working.`
            : `${engine === 'ytdlp' ? 'yt-dlp' : 'FFmpeg'} was not found.`,
        );
      } else {
        setter((prev) => ({ ...prev, status: 'error', error: result.error || 'Verification failed' }));
        addToast('error', 'Verification Failed', result.error || 'Could not verify the engine.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setter((prev) => ({ ...prev, status: 'error', error: msg }));
      addToast('error', 'Verification Failed', msg);
    }
  };

  const handleCheckLatest = async (engine: 'ytdlp' | 'ffmpeg') => {
    const setter = engine === 'ytdlp' ? setYtdlp : setFfmpeg;
    setter((prev) => ({ ...prev, status: 'checking', error: '' }));

    try {
      const result = await novaClient.checkEngineLatestVersion(engine);
      if (result.ok) {
        setter((prev) => ({
          ...prev,
          status: 'done',
          latestVersion: result.latestVersion || '',
          currentVersion: result.currentVersion || prev.version,
          updateAvailable: result.updateAvailable ?? false,
        }));
        if (result.updateAvailable) {
          const lv = result.latestVersion;
          const cv = result.currentVersion || 'unknown';
          addToast('info', 'Update Available', `Latest: ${lv} (current: ${cv})`);
        } else {
          const lv = result.latestVersion;
          addToast('success', 'Up to Date', `Version ${lv} is current.`);
        }
      } else {
        setter((prev) => ({ ...prev, status: 'error', error: result.error || 'Check failed' }));
        addToast('error', 'Check Failed', result.error || 'Could not check for updates.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setter((prev) => ({ ...prev, status: 'error', error: msg }));
      addToast('error', 'Check Failed', msg);
    }
  };

  const renderEngineCard = (
    engine: 'ytdlp' | 'ffmpeg',
    state: EngineState,
    icon: React.ReactNode,
    label: string,
    description: string,
    downloadUrl: string,
  ) => {
    const isBusy = state.status === 'downloading' || state.status === 'verifying' || state.status === 'checking';
    const displayName = engine === 'ytdlp' ? 'yt-dlp' : 'FFmpeg';

    return (
      <div
        className={`rounded-lg border p-4 transition-all ${
          state.available
            ? 'border-[var(--success-border)] bg-[var(--success-bg)]'
            : 'border-[var(--danger-border)] bg-[var(--danger-bg)]'
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                state.available
                  ? 'bg-[var(--success)]/15 text-[var(--success)]'
                  : 'bg-[var(--danger)]/15 text-[var(--danger)]'
              }`}
            >
              {icon}
            </div>
            <div>
              <h3 className="text-sm font-extrabold text-[var(--text-primary)] flex items-center gap-2">
                {displayName}
                {state.available ? (
                  <CheckCircle className="w-3.5 h-3.5 text-[var(--success)]" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5 text-[var(--danger)]" />
                )}
              </h3>
              <p className="text-[10px] text-[var(--text-muted)]">{description}</p>
            </div>
          </div>
          {state.version && (
            <span className="text-[10px] font-mono font-bold text-[var(--text-secondary)] bg-[var(--bg-input)] px-2 py-1 rounded">
              v{state.version}
            </span>
          )}
        </div>

        {/* Status row */}
        <div className="flex items-center gap-2 mb-3 text-[11px]">
          <span
            className={`flex items-center gap-1 font-bold ${
              state.available ? 'text-[var(--success)]' : 'text-[var(--danger)]'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${state.available ? 'bg-[var(--success)]' : 'bg-[var(--danger)]'} ${state.available ? 'animate-pulse' : ''}`} />
            {state.available ? 'Installed' : 'Not Installed'}
          </span>
          {state.latestVersion && (
            <>
              <span className="text-[var(--text-muted)]">|</span>
              <span className="text-[var(--text-secondary)]">
                Latest: <span className="font-mono font-bold">{state.latestVersion}</span>
              </span>
              {state.updateAvailable && (
                <span className="text-[var(--warning)] font-bold flex items-center gap-0.5">
                  <RefreshCw className="w-3 h-3" />
                  Update available
                </span>
              )}
            </>
          )}
        </div>

        {/* Path */}
        {state.path && (
          <div className="mb-3 text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-input)] rounded px-2 py-1 truncate" title={state.path}>
            {state.path}
          </div>
        )}

        {/* Error */}
        {state.error && (
          <div className="mb-3 text-[11px] text-[var(--danger)] bg-[var(--danger)]/10 rounded px-2 py-1.5 flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{state.error}</span>
          </div>
        )}

        {/* Buttons */}
        <div className="flex flex-wrap gap-2">
          {engine === 'ytdlp' && (
            <button
              onClick={() => {
                void handleDownload(engine);
              }}
              disabled={isBusy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-wait"
            >
              {state.status === 'downloading' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              {state.status === 'downloading'
                ? 'Downloading...'
                : state.available
                  ? 'Re-download'
                  : 'Download'}
            </button>
          )}
          <button
            onClick={() => {
              void handleVerify(engine);
            }}
            disabled={isBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
          >
            {state.status === 'verifying' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CheckCircle className="w-3.5 h-3.5" />
            )}
            Verify
          </button>
          <button
            onClick={() => {
              void handleCheckLatest(engine);
            }}
            disabled={isBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
          >
            {state.status === 'checking' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Check Latest
          </button>
          <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Releases
          </a>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 pb-2 border-b border-[var(--border-color)]">
        <Activity className="w-4 h-4 text-[var(--accent-primary)]" />
        <h2 className="text-sm font-extrabold text-[var(--text-primary)]">Engine Manager</h2>
      </div>

      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
        Manage external engine binaries. yt-dlp handles media downloads (YouTube, etc.) and FFmpeg handles
        post-processing (merge, convert, embed subtitles). Download yt-dlp directly from here, or point to a
        system FFmpeg installation via the Media Download tab.
      </p>

      {/* Engine capability summary */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-input)] p-2.5 text-center">
          <div className={`text-xs font-bold ${engineCapabilities.directReady ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
            {engineCapabilities.directReady ? 'Ready' : 'Unavailable'}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] mt-0.5">Direct Engine</div>
        </div>
        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-input)] p-2.5 text-center">
          <div className={`text-xs font-bold ${engineCapabilities.mediaReady ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
            {engineCapabilities.mediaReady ? 'Ready' : 'Unavailable'}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] mt-0.5">Media Engine</div>
        </div>
        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-input)] p-2.5 text-center">
          <div className={`text-xs font-bold ${engineCapabilities.postProcessingReady ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
            {engineCapabilities.postProcessingReady ? 'Ready' : 'Unavailable'}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] mt-0.5">Post-Processor</div>
        </div>
      </div>

      {/* Engine cards */}
      {renderEngineCard(
        'ytdlp',
        ytdlp,
        <Video className="w-5 h-5" />,
        'yt-dlp',
        'Media extraction engine for YouTube, playlists, and 1000+ sites',
        'https://github.com/yt-dlp/yt-dlp/releases',
      )}

      {renderEngineCard(
        'ffmpeg',
        ffmpeg,
        <Code className="w-5 h-5" />,
        'FFmpeg',
        'Post-processing: merge audio/video, convert formats, embed subtitles',
        'https://ffmpeg.org/download.html',
      )}

      {/* Info note */}
      <div className="flex items-start gap-2 p-3 bg-[var(--bg-hover)]/20 rounded-lg border border-[var(--border-color)]/30">
        <AlertCircle className="w-4 h-4 text-[var(--info)] shrink-0 mt-0.5" />
        <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
          <strong className="text-[var(--text-secondary)]">Note:</strong> yt-dlp can be downloaded and updated
          directly from this page. FFmpeg must be installed via your system package manager (e.g.{' '}
          <code className="font-mono">winget install ffmpeg</code> or{' '}
          <code className="font-mono">apt install ffmpeg</code>), or you can specify a custom path in the Media
          Download settings tab.
        </div>
      </div>
    </div>
  );
};
