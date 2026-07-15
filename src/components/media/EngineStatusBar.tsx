import React from 'react';
import { Radio, Code, Loader2 } from 'lucide-react';
import { Switch } from '../primitives';
import type { EngineCapabilitySnapshot } from '../../capabilities/EngineCapabilityContext';

interface EngineStatusBarProps {
  engineCapabilities: EngineCapabilitySnapshot;
  ffmpegAvailable: boolean | null;
  ffmpegEnabled: boolean;
  onFfmpegEnabledChange: (v: boolean) => void;
}

export const EngineStatusBar: React.FC<EngineStatusBarProps> = ({
  engineCapabilities,
  ffmpegAvailable,
  ffmpegEnabled,
  onFfmpegEnabledChange,
}) => (
  <div className="flex items-center gap-3 p-2.5 bg-[var(--bg-hover)]/20 border border-[var(--border-color)]/30 rounded-xl">
    {/* yt-dlp */}
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      <Radio
        className={`w-3.5 h-3.5 shrink-0 ${engineCapabilities.mediaReady ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}
      />
      <div className="min-w-0">
        <span className="text-[10px] font-bold text-[var(--text-primary)] block leading-none">yt-dlp</span>
        <span className={`text-[9px] ${engineCapabilities.mediaReady ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
          {engineCapabilities.mediaReady ? 'Ready' : 'Unavailable'}
        </span>
      </div>
    </div>

    <div className="w-px h-6 bg-[var(--border-color)]/30 shrink-0" />

    {/* FFmpeg */}
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      <Code
        className={`w-3.5 h-3.5 shrink-0 ${
          ffmpegAvailable === null ? 'text-[var(--text-muted)]' : ffmpegAvailable ? 'text-[var(--success)]' : 'text-[var(--danger)]'
        }`}
      />
      <div className="min-w-0">
        <span className="text-[10px] font-bold text-[var(--text-primary)] block leading-none">FFmpeg</span>
        {ffmpegAvailable === null ? (
          <span className="text-[9px] text-[var(--text-muted)] flex items-center gap-1">
            <Loader2 className="w-2.5 h-2.5 animate-spin" /> Checking
          </span>
        ) : ffmpegAvailable ? (
          <span className="text-[9px] text-[var(--success)]">Ready</span>
        ) : (
          <span className="text-[9px] text-[var(--danger)]">Not detected</span>
        )}
      </div>
    </div>

    <div className="w-px h-6 bg-[var(--border-color)]/30 shrink-0" />

    {/* FFmpeg toggle */}
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-[9px] text-[var(--text-muted)]">FFmpeg Plugin</span>
      <Switch
        label=""
        checked={ffmpegEnabled && ffmpegAvailable === true}
        onChange={onFfmpegEnabledChange}
        id="page-ffmpeg"
        disabled={ffmpegAvailable !== true}
      />
    </div>
  </div>
);
