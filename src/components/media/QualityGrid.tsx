import React from 'react';
import { LayoutGrid, CheckCircle2, Info } from 'lucide-react';
import type { MediaFormat } from '../../api/novaClient';
import { formatBytes } from '../../initialData';
import { resolutionBadgeColor, resolutionLabel } from './mediaHelpers';

export interface QualityOption {
  value: string;
  label: string;
  size: string;
  sizeBytes: number;
  needsFfmpeg: boolean;
  codecInfo: string;
  height: number;
  fps: number;
  ext: string;
  formatNote: string;
  hasAudio: boolean;
  tbr: number;
}

interface QualityGridProps {
  options: QualityOption[];
  quality: string;
  onQualityChange: (q: string) => void;
  selectedFormat: MediaFormat | null;
  selectedFormatSize: number;
  requiresFfmpeg: boolean;
  ffmpegAvailable: boolean | null;
  mediaReady?: boolean;
  onOpenEnginesSettings?: () => void;
}

export const QualityGrid: React.FC<QualityGridProps> = ({
  options,
  quality,
  onQualityChange,
  selectedFormat,
  selectedFormatSize,
  requiresFfmpeg,
  ffmpegAvailable,
  mediaReady = true,
  onOpenEnginesSettings,
}) => (
  <div className="space-y-2">
    {!mediaReady && (
      <div className="flex items-center justify-between bg-[var(--danger-bg)]/5 border border-[var(--danger-border)] text-[var(--danger)] px-3 py-2 rounded-lg">
        <div className="flex items-center gap-2">
          <Info className="w-4 h-4" />
          <div className="text-[11px]">yt-dlp is not available — media probing and some formats are disabled.</div>
        </div>
        <div>
          <button
            type="button"
            onClick={() => onOpenEnginesSettings?.()}
            className="px-2 py-1 text-[11px] bg-[var(--accent-primary)] text-white rounded-md"
          >
            Configure
          </button>
        </div>
      </div>
    )}
    <div className="flex items-center justify-between">
      <span className="text-xs font-extrabold text-[var(--text-primary)] flex items-center gap-1.5">
        <LayoutGrid className="w-3.5 h-3.5 text-[var(--danger)]" />
        Video Quality
      </span>
      {selectedFormatSize > 0 && (
        <span className="text-[10px] text-[var(--text-muted)] font-mono">
          {formatBytes(selectedFormatSize)}
          {selectedFormat?.tbr ? ` @ ${selectedFormat.tbr.toFixed(0)} kbps` : ''}
        </span>
      )}
    </div>

    <div className="grid grid-cols-1 gap-1.5 max-h-80 overflow-y-auto scrollbar-thin pr-0.5">
      {options.map((opt) => {
        const isSelected = quality === opt.value;
        const badgeColor = resolutionBadgeColor(opt.height);
        const needsFfmpegButMissing = opt.needsFfmpeg && ffmpegAvailable === false;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              onQualityChange(opt.value);
            }}
            className={`w-full flex items-center gap-3 p-2.5 rounded-xl border transition-all ${
              isSelected
                ? 'bg-[var(--danger)]/8 border-[var(--danger-border)] shadow-[0_0_10px_-3px_rgba(239,68,68,0.25)]'
                : 'bg-[var(--bg-hover)]/20 border-[var(--border-color)]/30 hover:border-[var(--border-color)] hover:bg-[var(--bg-hover)]/40'
            } text-left`}
          >
            {opt.value === 'best' ? (
              <span className="w-[52px] text-center text-[10px] font-extrabold text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg py-1 shrink-0">
                BEST
              </span>
            ) : (
              <span
                className={`w-[52px] text-center text-[10px] font-extrabold rounded-lg py-1 border shrink-0 ${badgeColor}`}
              >
                {resolutionLabel(opt.height)}
              </span>
            )}

            <div className="flex-1 min-w-0">
              {opt.value === 'best' ? (
                <span className="text-[11px] text-[var(--text-secondary)] font-semibold">Highest available</span>
              ) : (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {opt.codecInfo && (
                    <span className="text-[10px] text-[var(--text-muted)] font-mono">{opt.codecInfo}</span>
                  )}
                  {opt.ext && (
                    <span className="text-[9px] text-[var(--text-secondary)] uppercase font-bold border border-[var(--border-color)] px-1 rounded">
                      {opt.ext}
                    </span>
                  )}
                  {opt.fps >= 60 && <span className="text-[9px] text-[var(--warning)] font-bold">{opt.fps}fps</span>}
                  {opt.hasAudio ? (
                    <span className="text-[9px] text-[var(--success)] font-bold">Muxed</span>
                  ) : (
                    <span className="text-[9px] text-[var(--warning)] font-bold">Needs FFmpeg</span>
                  )}
                </div>
              )}
              {opt.formatNote && (
                <span className="text-[9px] text-[var(--text-secondary)] truncate block mt-0.5">{opt.formatNote}</span>
              )}
            </div>

            {opt.size && <span className="text-[10px] text-[var(--text-muted)] shrink-0 font-mono">{opt.size}</span>}

            {isSelected && <CheckCircle2 className="w-4 h-4 text-[var(--danger)] shrink-0" />}
            {needsFfmpegButMissing && (
              <span className="text-[9px] text-[var(--warning)] font-bold block ml-2">Needs FFmpeg</span>
            )}
          </button>
        );
      })}
    </div>

    {requiresFfmpeg && ffmpegAvailable && quality !== 'best' && (
      <div className="flex items-center gap-1.5 text-[10px] text-[var(--warning)] bg-[var(--warning)]/5 border border-[var(--warning-border)] rounded-lg px-2.5 py-1.5">
        <Info className="w-3 h-3 shrink-0" />
        This quality requires FFmpeg to merge video+audio streams.
      </div>
    )}
  </div>
);
