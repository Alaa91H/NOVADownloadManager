import React from 'react';
import { Music, CheckCircle2 } from 'lucide-react';
import { formatBytes } from '../../initialData';

export interface AudioOption {
  value: string;
  label: string;
  needsFfmpeg: boolean;
  bitrate: string;
  sizeBytes: number;
  ext: string;
  description: string;
}

interface AudioGridProps {
  options: AudioOption[];
  audioFormat: string;
  onAudioFormatChange: (fmt: string) => void;
  ffmpegEnabled: boolean;
  convertBitrate: string;
  onBitrateChange: (b: string) => void;
}

export const AudioGrid: React.FC<AudioGridProps> = ({
  options,
  audioFormat,
  onAudioFormatChange,
  ffmpegEnabled,
  convertBitrate,
  onBitrateChange,
}) => (
  <div className="space-y-2">
    <span className="text-xs font-extrabold text-[var(--text-primary)] flex items-center gap-1.5">
      <Music className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
      Audio Format
    </span>

    <div className="grid grid-cols-2 gap-1.5">
      {options.map((opt) => {
        const isSelected = audioFormat === opt.value;
        const disabled = opt.needsFfmpeg && !ffmpegEnabled;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              if (disabled) return;
              onAudioFormatChange(opt.value);
            }}
            disabled={disabled}
            className={`p-3 rounded-xl border transition-all ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} text-left ${
              isSelected
                ? 'bg-[var(--accent-primary)]/8 border-[var(--accent-primary)]/30 shadow-[0_0_10px_-3px_rgba(168,85,247,0.2)]'
                : 'bg-[var(--bg-hover)]/20 border-[var(--border-color)]/30 hover:border-[var(--border-color)] hover:bg-[var(--bg-hover)]/40'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-extrabold text-[var(--text-primary)]">{opt.label}</span>
              {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent-primary)]" />}
            </div>
            <span className="text-[10px] text-[var(--text-secondary)] block">{opt.description}</span>
            {opt.bitrate && (
              <span className="text-[9px] text-[var(--text-secondary)] font-mono block mt-0.5">{opt.bitrate}</span>
            )}
            {opt.sizeBytes > 0 && (
              <span className="text-[9px] text-[var(--text-secondary)] font-mono block mt-0.5">
                {formatBytes(opt.sizeBytes)}
              </span>
            )}
            {opt.needsFfmpeg && (
              <span className="text-[9px] text-[var(--warning)] font-bold block mt-1">Needs FFmpeg</span>
            )}
          </button>
        );
      })}
    </div>

    {ffmpegEnabled && (
      <div className="flex items-center gap-2.5 p-2.5 bg-[var(--bg-hover)]/20 border border-[var(--border-color)]/30 rounded-xl">
        <span className="text-[11px] text-[var(--text-secondary)] font-bold shrink-0">Bitrate</span>
        <select
          value={convertBitrate}
          onChange={(e) => {
            onBitrateChange(e.target.value);
          }}
          className="flex-1 text-[11px] font-semibold bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg px-2 py-1 text-[var(--text-primary)] focus-visible:outline-none cursor-pointer"
        >
          <option value="320k">320 kbps</option>
          <option value="256k">256 kbps</option>
          <option value="192k">192 kbps</option>
          <option value="128k">128 kbps</option>
        </select>
      </div>
    )}
  </div>
);
