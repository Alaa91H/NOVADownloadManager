import React from 'react';
import { Sliders } from 'lucide-react';
import { SpeedLimitInput } from './SpeedLimitInput';

interface SchedulerSpeedTabProps {
  limitSpeed: boolean;
  onLimitSpeedChange: (v: boolean) => void;
  speedLimitKbs: number;
  onSpeedLimitChange: (v: number) => void;
  oneTimeLimit: boolean;
  onOneTimeLimitChange: (v: boolean) => void;
}

export const SchedulerSpeedTab: React.FC<SchedulerSpeedTabProps> = ({
  limitSpeed, onLimitSpeedChange,
  speedLimitKbs, onSpeedLimitChange,
  oneTimeLimit, onOneTimeLimitChange,
}) => {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between bg-[var(--bg-hover)]/40 p-3 rounded-lg border border-[var(--border-color)] shadow-sm">
        <div className="flex flex-col text-right">
          <span className="text-xs md:text-sm font-bold text-[var(--text-primary)]">
            {'Speed Limiter'}
          </span>
          <span className="text-[10px] text-[var(--text-muted)]">
            {'Limit speed to protect total bandwidth'}
          </span>
        </div>
        <input
          type="checkbox"
          checked={limitSpeed}
          onChange={(e) => onLimitSpeedChange(e.target.checked)}
          className="w-4.5 h-4.5 rounded text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
        />
      </div>

      {limitSpeed && (
        <div className="p-4 bg-[var(--bg-input)]/40 border border-[var(--border-color)] rounded-xl space-y-4 shadow-inner">
          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <span className="text-xs text-[var(--text-secondary)] font-bold">{'Set max speed'}</span>
              <div dir="ltr">
                <SpeedLimitInput
                  maxSpeedKbs={speedLimitKbs}
                  onChange={(v) => onSpeedLimitChange(v)}
                  compact={false}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 text-xs text-[var(--text-secondary)] leading-relaxed bg-amber-500/5 border border-amber-500/10 p-3 rounded-lg">
            <Sliders className="w-4 h-4 text-amber-500 shrink-0" />
            <span>
              {'Speed limit helps you browse websites smoothly while downloading in the background.'}
            </span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between bg-[var(--bg-hover)]/40 p-3 rounded-lg border border-[var(--border-color)] shadow-sm">
        <div className="flex flex-col text-right">
          <span className="text-xs md:text-sm font-bold text-[var(--text-primary)]">
            {'One-time speed limit'}
          </span>
          <span className="text-[10px] text-[var(--text-muted)]">
            {'Apply the speed limit only to the next download session'}
          </span>
        </div>
        <input
          type="checkbox"
          checked={oneTimeLimit}
          onChange={(e) => onOneTimeLimitChange(e.target.checked)}
          className="w-4.5 h-4.5 rounded text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
        />
      </div>
    </div>
  );
};
