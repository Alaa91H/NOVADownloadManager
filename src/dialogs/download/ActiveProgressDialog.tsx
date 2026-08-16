/* src/dialogs/download/ActiveProgressDialog.tsx */
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  useDialogData,
  useTaskData,
  useTaskActions,
  useSettingsData,
  useSettingsActions,
  useI18n,
} from '../../store/selectors';
import { useEngineAdaptive } from '../../store/selectors';
import { useEngineStore } from '../../store/engineStore';
import type { DownloadItem, DownloadSegment } from '../../types/desktop-ui.types';
import { formatBytes } from '../../initialData';
import { formatSpeed, formatElapsed, formatTimeLeft } from '../../utils/formatUtils';
import { taskProgressInfo } from '../../utils/progressUtils';
import {
  TaskProgressBar,
  ProgressHeadBadge,
  ProgressLegend,
  progressToneFillClass,
  type ProgressTone,
} from '../../components/primitives/TaskProgressBar';

/** Map a segment's engine state to the shared progress-bar tone so the whole
 *  app uses the same active/completed/idle colour language. */
const segmentTone = (seg: DownloadSegment): ProgressTone => {
  if (seg.active && seg.progress < 1) return 'accent';
  if (seg.progress >= 1) return 'success';
  return 'muted';
};

/** Rich hover tooltip anchored above the hovered composite-bar cell: segment
 *  number, state, bytes, live speed and ETA. Anchored by percentage so it
 *  tracks the (equal-width) cell without measuring the DOM, and clamped so it
 *  never overhangs the bar edges. */
const SegmentHoverTooltip: React.FC<{
  seg: DownloadSegment;
  segTotal: number;
  segDownloaded: number;
  hoverLeft: number;
  t: (key: string) => string;
}> = React.memo(({ seg, segTotal, segDownloaded, hoverLeft, t }) => {
  const remaining = Math.max(0, segTotal - segDownloaded);
  const eta = seg.speed > 0 ? remaining / seg.speed : null;
  const stateLabel =
    seg.progress >= 1 ? t('progress_complete') : seg.active ? t('progress_receiving') : t('progress_idle');
  const stateColor =
    seg.progress >= 1
      ? 'text-[var(--success)]'
      : seg.active
        ? 'text-[var(--accent-primary)]'
        : 'text-[var(--text-secondary)]';
  return (
    <div
      id="seg-tooltip"
      data-testid="seg-tooltip"
      role="tooltip"
      className="absolute bottom-full mb-1.5 z-30 -translate-x-1/2 pointer-events-none rounded-lg border border-[var(--border-color)] bg-[var(--bg-surface-elevated)] px-2 py-1 shadow-lg text-[10px] text-[var(--text-primary)] whitespace-nowrap"
      style={{ left: `${String(hoverLeft)}%` }}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-bold">
          {t('progress_seg_number')} {String(seg.id)}
        </span>
        <span className={`font-semibold ${stateColor}`}>{stateLabel}</span>
      </div>
      <div className="mt-0.5 font-mono text-[var(--text-muted)]">
        {formatBytes(segDownloaded)} <span className="text-[var(--text-secondary)]">/</span> {formatBytes(segTotal)}
        <span className="mx-1 text-[var(--text-secondary)]">·</span>
        <span className="font-bold text-[var(--accent-primary)]">{formatSpeed(seg.speed)}</span>
        <span className="mx-1 text-[var(--text-secondary)]">·</span>
        <span className="text-[var(--info)]">
          {t('progress_eta')} {eta != null ? formatTimeLeft(Math.ceil(eta)) : '--'}
        </span>
      </div>
    </div>
  );
});
SegmentHoverTooltip.displayName = 'SegmentHoverTooltip';

const SegmentCard: React.FC<{
  seg: DownloadSegment;
  segTotal: number;
  segDownloaded: number;
  isActive: boolean;
  /** True when the matching composite-bar cell is hovered — lifts the card so
   *  the hover linking between the bar and the grid is visible. */
  highlighted?: boolean;
  /** Called with the segment id on hover and null on leave (bar↔card link). */
  onHoverChange?: (id: number | null) => void;
  t: (key: string) => string;
}> = React.memo(({ seg, segTotal, segDownloaded, isActive, highlighted = false, onHoverChange, t }) => {
  const segPercent = segTotal > 0 ? Math.round((segDownloaded / segTotal) * 100) : 0;
  const segProgress = taskProgressInfo({
    sizeBytes: segTotal,
    downloadedBytes: segDownloaded,
    status: isActive && seg.progress < 1 ? 'downloading' : seg.progress >= 1 ? 'completed' : 'paused',
  });

  return (
    <div
      data-testid={`segment-card-${String(seg.id)}`}
      className={`relative group border rounded-lg overflow-hidden transition-all duration-300 ${
        highlighted ? 'ring-2 ring-[var(--accent-primary)]/60 shadow-lg border-[var(--accent-primary)]/40' : ''
      } ${
        isActive
          ? `border-[var(--border-color)] bg-[var(--bg-surface-elevated)] shadow-md`
          : seg.progress >= 1
            ? 'border-[var(--success)]/30 bg-[var(--success)]/5'
            : 'border-[var(--border-color)] bg-[var(--bg-input)] opacity-70'
      }`}
      onMouseEnter={() => onHoverChange?.(seg.id)}
      onMouseLeave={() => onHoverChange?.(null)}
    >
      {isActive && (
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.02] to-transparent animate-[shimmer_3s_ease-in-out_infinite]" />
      )}

      <div className="relative flex items-center gap-3 px-3 py-2.5">
        <div className="flex flex-col items-center justify-center min-w-[40px]">
          <div
            className={`w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-bold font-mono ${
              isActive
                ? 'bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]'
                : 'bg-[var(--bg-input)] text-[var(--text-secondary)]'
            }`}
          >
            {seg.id}
          </div>
          {isActive && seg.progress < 1 && (
            <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)] mt-1 animate-pulse" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1.5">
            <span
              className={`text-[11px] font-bold ${isActive ? 'text-[var(--accent-primary)]' : 'text-[var(--text-secondary)]'}`}
            >
              {seg.progress >= 1 ? t('progress_complete') : seg.active ? t('progress_receiving') : t('progress_idle')}
            </span>
            <span className="text-[10px] font-mono text-[var(--text-muted)]">
              {formatBytes(segDownloaded)}{' '}
              <span className="text-[var(--text-secondary)]/50">{t('progress_seg_of')}</span> {formatBytes(segTotal)}
            </span>
          </div>

          {/* Shared TaskProgressBar — same always-mounted fill + cross-fade as
              every other surface; tone keeps the active/completed/idle colours.
              The active segment also gets a live head badge showing where its
              bytes are arriving. */}
          <TaskProgressBar
            progress={segProgress}
            active={isActive}
            tone={segmentTone(seg)}
            headLabel={isActive ? `${String(segPercent)}%` : undefined}
            trackClass="h-2"
            showLabel={false}
            ariaLabel={`${t('progress_seg_number')} ${String(seg.id)}`}
          />

          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] font-mono text-[var(--text-muted)]">{segPercent}%</span>
            {isActive && seg.speed > 0 && (
              <span className="text-[10px] font-mono font-bold text-[var(--accent-primary)]">
                {formatSpeed(seg.speed)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
SegmentCard.displayName = 'SegmentCard';

export const ActiveProgressDialog: React.FC<{ taskId?: string }> = ({ taskId }) => {
  const dialog = useDialogData();
  const tasks = useTaskData();
  const { pauseTask, resumeTask } = useTaskActions();
  const settings = useSettingsData();
  const { updateSettings } = useSettingsActions();
  const t = useI18n();
  const taskFromPayload = dialog.payload as DownloadItem | null | undefined;
  // Always use the live store version of the task so progress bars and segment
  // data update reactively. The payload acts only as a fallback identity hint
  // before SSE delivers the first store update.
  const liveTask = useMemo(() => {
    const hintedId = taskId || taskFromPayload?.id;
    if (hintedId) return tasks.find((tt) => tt.id === hintedId);
    return tasks.find((tt) => tt.status === 'downloading');
  }, [tasks, taskId, taskFromPayload?.id]);
  const task = liveTask ?? taskFromPayload ?? null;

  const [activeTab, setActiveTab] = useState<'status' | 'speed'>('status');
  // Collapsed by default so the dialog opens compact; the toggle reveals the
  // tabs, details and per-segment cards.
  const [detailsCollapsed, setDetailsCollapsed] = useState(true);
  // Hover linking between the composite distribution bar and the segment cards:
  // hovering a BAR cell shows a rich tooltip AND highlights the matching card;
  // hovering a CARD highlights its cell in turn but never shows the tooltip.
  // Two separate ids let the tooltip stay reserved for bar-cell hovers while
  // the highlight follows whichever surface is under the pointer.
  const [hoveredCellId, setHoveredCellId] = useState<number | null>(null);
  const [hoveredCardId, setHoveredCardId] = useState<number | null>(null);
  const activeHoverId = hoveredCellId ?? hoveredCardId;
  const segmentGridRef = useRef<HTMLDivElement | null>(null);
  const handleCardHover = useCallback((id: number | null) => {
    setHoveredCardId(id);
  }, []);
  // Keep the highlighted card visible inside the scrollable grid.
  useEffect(() => {
    if (activeHoverId == null || !segmentGridRef.current) return;
    segmentGridRef.current
      .querySelector(`[data-testid="segment-card-${String(activeHoverId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeHoverId]);
  const speedLimitEnabled = settings.connection.speedLimiter.enabled;
  const speedLimitValue = settings.connection.speedLimiter.maxSpeedKbs;

  const progress = taskProgressInfo(task);

  const activeSegments = useMemo(() => (task ? task.segments.filter((s) => s.active && s.progress < 1) : []), [task]);
  const completedSegments = useMemo(() => (task ? task.segments.filter((s) => s.progress >= 1) : []), [task]);
  const totalActiveSpeed = useMemo(
    () => (task ? task.segments.reduce((sum, s) => sum + (s.active ? s.speed : 0), 0) : 0),
    [task],
  );

  // Pull engine telemetry (adaptive connections + segment progress + retry
  // state) for the active task so the dialog reflects the engine's real-time
  // state, not just the SSE download snapshot.
  const adaptive = useEngineAdaptive(task?.id ?? null);
  useEffect(() => {
    if (!task) return;
    const refresh = useEngineStore.getState();
    void refresh.refreshAdaptive(task.id);
    void refresh.refreshSegments(task.id);
    const interval = window.setInterval(() => {
      const s = useEngineStore.getState();
      void s.refreshAdaptive(task.id);
      void s.refreshSegments(task.id);
    }, 3000);
    return () => {
      window.clearInterval(interval);
    };
    // Re-subscribe only when the task identity changes, not on every snapshot update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  if (!task) {
    return null;
  }

  const handleToggleSpeedLimit = (checked: boolean) => {
    updateSettings(
      {
        ...settings,
        connection: {
          ...settings.connection,
          speedLimiter: {
            ...settings.connection.speedLimiter,
            enabled: checked,
            maxSpeedKbs: speedLimitValue,
          },
        },
      },
      true,
    );
  };

  const handleSpeedLimitValueChange = (val: string) => {
    const num = parseInt(val, 10) || 10;
    updateSettings(
      {
        ...settings,
        connection: {
          ...settings.connection,
          speedLimiter: {
            ...settings.connection.speedLimiter,
            maxSpeedKbs: num,
          },
        },
      },
      true,
    );
  };

  const tabClass = (tab: typeof activeTab) =>
    `px-4 py-1 text-[11px] font-bold border-t border-l border-r transition-all duration-150 cursor-pointer ${
      activeTab === tab
        ? 'bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] border-[var(--border-color)] pt-1 pb-1.5 -mb-[1px] z-10'
        : 'bg-[var(--bg-input)] text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] pb-1'
    }`;

  const isDownloading = task.status === 'downloading';

  return (
    <div
      className="space-y-2 font-sans text-xs text-[var(--text-primary)] select-none pb-1"
      style={{ direction: 'ltr' }}
    >
      {/* Segmented Progress Bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-[var(--text-secondary)]">{t('progress_overall_progress')}</span>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold font-mono text-[var(--accent-primary)]">
              {progress.percentLabel}
            </span>
          </div>
        </div>
        {/* Primary smooth overall bar — shares the cross-fade indeterminate→percent
            behaviour of the table/card bars so every renderer is consistent. */}
        <TaskProgressBar
          progress={progress}
          active={isDownloading}
          trackClass="h-2"
          showLabel={false}
          ariaLabel={task.name}
        />
        {/* Per-segment distribution breakdown — visually subordinate to the
            primary smooth overall bar above. The wrapper is relative so the
            rich hover tooltip can float above the bar without being clipped. */}
        <div className="relative" style={{ direction: 'ltr' }}>
          <div
            data-testid="seg-bar"
            className="w-full h-4 bg-[var(--bg-input)] border border-[var(--border-color)] flex rounded-md overflow-hidden select-none shadow-inner"
            onMouseLeave={() => {
              setHoveredCellId(null);
            }}
          >
            {task.segments.map((seg) => {
              const segPercent = Math.round(seg.progress * 100);
              return (
                <div
                  key={seg.id}
                  role="img"
                  aria-label={`${t('progress_seg_number')} ${String(seg.id)}: ${String(segPercent)}%`}
                  data-testid={`seg-cell-${String(seg.id)}`}
                  className={`h-full flex-1 border-r border-[var(--border-color)]/30 last:border-r-0 relative bg-[var(--bg-input)] transition-all duration-150 cursor-pointer ${
                    activeHoverId === seg.id ? 'brightness-125 ring-1 ring-inset ring-[var(--accent-primary)]/70' : ''
                  }`}
                  // The rich tooltip replaces the browser's delayed native
                  // tooltip, so no `title` here. Clearing happens only at the
                  // bar container level so the tooltip glides between adjacent
                  // cells instead of unmounting mid-flight.
                  aria-describedby={hoveredCellId === seg.id ? 'seg-tooltip' : undefined}
                  onMouseEnter={() => {
                    setHoveredCellId(seg.id);
                  }}
                >
                  {/* Always-mounted fill so each segment glides from 0% smoothly;
                      colours come from the same shared tone map as the cards. */}
                  <div
                    className={`h-full absolute top-0 left-0 transition-all duration-300 ${progressToneFillClass[segmentTone(seg)]}`}
                    style={{ width: `${String(segPercent)}%` }}
                  />
                  {/* Per-segment download-head badge — the exact shared pill used
                      by the cards and every other surface (same clamp math, same
                      glide, same live pulse). Only active segments carry one, so
                      a finished segment can never overhang its cell. */}
                  {seg.active && seg.progress < 1 && (
                    <ProgressHeadBadge percent={segPercent} label={`${String(segPercent)}%`} dataTestId="seg-head" />
                  )}
                  {isDownloading && seg.active && seg.progress < 1 && (
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent animate-[shimmer_2s_ease-in-out_infinite]" />
                  )}
                  {/* Hover anchor dot — centres the tooltip over this cell. */}
                  {hoveredCellId === seg.id && (
                    <div
                      className="absolute -bottom-px left-0 right-0 h-[3px] bg-[var(--accent-primary)]"
                      data-testid={`seg-hover-mark-${String(seg.id)}`}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {/* Rich hover tooltip — anchored at the hovered cell's centre, clamped
              to the bar edges. Shows segment number, state, bytes, speed + ETA.
              Rendered ONLY for bar-cell hovers (card hovers just highlight). */}
          {hoveredCellId != null &&
            (() => {
              const segIdx = task.segments.findIndex((s) => s.id === hoveredCellId);
              if (segIdx < 0) return null;
              const seg = task.segments[segIdx];
              const segTotal = seg.totalBytes || Math.round(task.sizeBytes / (task.segments.length || 8));
              const segDownloaded = seg.downloadedBytes || Math.round(seg.progress * segTotal);
              const hoverLeft = Math.min(90, Math.max(10, ((segIdx + 0.5) / task.segments.length) * 100));
              return (
                <SegmentHoverTooltip
                  seg={seg}
                  segTotal={segTotal}
                  segDownloaded={segDownloaded}
                  hoverLeft={hoverLeft}
                  t={t}
                />
              );
            })()}
        </div>
        {/* Shared legend — every entry is a mini head-badge pill tinted by the
            same exported tone map the bars use, so it reflects the engine's
            real palette and live segment counts. */}
        <ProgressLegend
          entries={[
            { tone: 'accent', label: t('progress_receiving'), count: activeSegments.length, live: isDownloading },
            { tone: 'success', label: t('progress_complete'), count: completedSegments.length },
            {
              tone: 'muted',
              label: t('progress_idle'),
              count: task.segments.length - activeSegments.length - completedSegments.length,
            },
          ]}
        />
      </div>

      {/* Live Stats Bar */}
      {isDownloading && (
        <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-surface-elevated)] border border-[var(--border-color)] rounded-lg">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)] animate-pulse" />
            <span className="text-[10px] font-bold text-[var(--accent-primary)]">
              {t('progress_active_connections')}
            </span>
          </div>
          <div className="h-3 w-px bg-[var(--border-color)]" />
          <span className="text-[10px] font-mono font-bold text-[var(--accent-primary)]">
            {activeSegments.length}/{task.segments.length}
          </span>
          <div className="h-3 w-px bg-[var(--border-color)]" />
          <span className="text-[10px] font-mono text-[var(--text-primary)]">
            {formatSpeed(totalActiveSpeed > 0 ? totalActiveSpeed : task.speedBytesPerSec)}
          </span>
          <div className="h-3 w-px bg-[var(--border-color)]" />
          <span className="text-[10px] font-mono text-[var(--info)]">
            {t('progress_eta')}: {formatElapsed(task.timeLeftSeconds)}
          </span>
        </div>
      )}

      {!detailsCollapsed && (
        <>
          <div
            className="flex border-b border-[var(--border-color)] select-none pl-1 mt-1"
            style={{ direction: 'ltr' }}
          >
            <button
              onClick={() => {
                setActiveTab('status');
              }}
              className={tabClass('status')}
              style={{ borderRadius: '4px 4px 0 0' }}
            >
              {t('progress_status_tab')}
            </button>
            <button
              onClick={() => {
                setActiveTab('speed');
              }}
              className={tabClass('speed')}
              style={{ borderRadius: '4px 4px 0 0' }}
            >
              {t('progress_speed_tab')}
            </button>
          </div>

          <div
            className="border border-[var(--border-color)] bg-[var(--bg-surface-elevated)] p-3 text-left rounded-b-md"
            style={{ minHeight: '170px' }}
          >
            {activeTab === 'status' && (
              <div className="space-y-2.5 animate-in fade-in duration-150">
                <div
                  className="text-left font-mono text-[11px] text-[var(--text-secondary)] bg-[var(--bg-input)] p-2 border border-[var(--border-color)] rounded select-all truncate"
                  style={{ direction: 'ltr' }}
                >
                  {task.url}
                </div>
                <div className="h-[1px] bg-[var(--border-color)]" />
                <div className="grid grid-cols-12 gap-y-2 text-[11px] md:text-xs">
                  <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_status')}</div>
                  <div className="col-span-9 text-[var(--text-primary)] font-medium capitalize">{task.status}</div>
                  {task.status === 'error' && task.errorMessage ? (
                    <>
                      <div className="col-span-3 text-[var(--danger)] font-semibold">{t('status_error')}</div>
                      <div className="col-span-9 text-[var(--danger)] font-mono text-[10px] break-all leading-relaxed">
                        {task.errorMessage}
                      </div>
                    </>
                  ) : null}
                  <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_file_size')}</div>
                  <div className="col-span-9 text-[var(--text-primary)] font-medium">{formatBytes(task.sizeBytes)}</div>
                  <div className="col-span-3 text-[var(--text-secondary)] font-semibold">
                    {t('progress_downloaded')}
                  </div>
                  <div className="col-span-9 text-[var(--text-primary)] font-medium">
                    {formatBytes(task.downloadedBytes)}
                    {!progress.indeterminate ? ` (${progress.percentLabel})` : ''}
                  </div>
                  <div className="col-span-3 text-[var(--text-secondary)] font-semibold">
                    {t('progress_transfer_rate')}
                  </div>
                  <div className="col-span-9 text-[var(--accent-primary)] font-bold">
                    {isDownloading ? formatSpeed(task.speedBytesPerSec) : '0 B/s'}
                  </div>
                  <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_time_left')}</div>
                  <div className="col-span-9 text-[var(--info)] font-semibold">
                    {isDownloading ? formatElapsed(task.timeLeftSeconds) : t('progress_not_running')}
                  </div>
                  <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_elapsed')}</div>
                  <div className="col-span-9 text-[var(--text-primary)] font-medium">
                    {formatElapsed(task.elapsedSeconds)}
                  </div>
                  <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_resume')}</div>
                  <div className="col-span-9 text-[var(--accent-primary)] font-bold">
                    {task.resumable ? t('task_supported') : t('task_not_supported')}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'speed' && (
              <div className="space-y-3.5 animate-in fade-in duration-150">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[var(--text-secondary)] font-semibold">{t('progress_transfer_rate')}</span>
                  <span className="text-[var(--accent-primary)] font-bold">
                    {isDownloading ? formatSpeed(task.speedBytesPerSec) : '0 B/s'}
                  </span>
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={speedLimitEnabled}
                    onChange={(e) => {
                      handleToggleSpeedLimit(e.target.checked);
                    }}
                    className="w-3.5 h-3.5 rounded border-[var(--border-color)] bg-[var(--bg-input)] text-[var(--accent-primary)] focus:ring-0 cursor-pointer"
                  />
                  <span className="text-xs text-[var(--text-primary)]">{t('progress_use_global_speed_limit')}</span>
                </label>
                <div className="space-y-1">
                  <span className="text-[11px] text-[var(--text-secondary)] block">{t('progress_max_speed')}</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={speedLimitValue}
                      onChange={(e) => {
                        handleSpeedLimitValueChange(e.target.value);
                      }}
                      disabled={!speedLimitEnabled}
                      className="w-20 bg-[var(--bg-input)] border border-[var(--border-color)] text-[var(--text-primary)] font-mono text-center text-xs py-0.5 px-2 focus:outline-none focus:border-[var(--accent-primary)] disabled:opacity-40 disabled:bg-[var(--bg-hover)] disabled:cursor-not-allowed"
                    />
                    <span className="text-[11px] text-[var(--text-secondary)]">KB/s</span>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setActiveTab('status');
                  }}
                  className="px-3.5 py-1 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] active:scale-95 border border-[var(--border-color)] text-[var(--text-primary)] text-[11px] font-sans font-bold shadow-sm transition-all cursor-pointer rounded-lg"
                >
                  {t('progress_hide_tab')}
                </button>
              </div>
            )}
          </div>

          {/* Segment Distribution Cards */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-[var(--text-secondary)]">
                {t('progress_segment_distribution')}
              </span>
              <span className="text-[10px] font-mono text-[var(--text-muted)]">
                {task.segments.length} {t('progress_seg_of')} {task.connections || task.segments.length}
              </span>
            </div>
            {/* Engine adaptive telemetry: live connection scaling + retry state. */}
            {(() => {
              if (!adaptive) return null;
              const retry = adaptive.retryState;
              return (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--text-muted)] font-mono px-1 pb-1">
                  {typeof adaptive.connections === 'number' && typeof adaptive.maxConnections === 'number' && (
                    <span>
                      {t('progress_seg_of') /* reuse "of" */} {String(adaptive.connections)}/
                      {String(adaptive.maxConnections)}
                    </span>
                  )}
                  {typeof adaptive.peakSpeed === 'number' && adaptive.peakSpeed > 0 && (
                    <span>peak: {formatSpeed(adaptive.peakSpeed)}</span>
                  )}
                  {retry && retry.totalRetries > 0 && (
                    <span className="text-[var(--warning)]">retries: {String(retry.totalRetries)}</span>
                  )}
                </div>
              );
            })()}
            <div
              ref={segmentGridRef}
              className="grid grid-cols-2 gap-1.5 max-h-52 overflow-y-auto overflow-x-hidden pr-1 scrollbar-thin"
            >
              {task.segments.map((seg) => {
                const segTotal = seg.totalBytes || Math.round(task.sizeBytes / (task.segments.length || 8));
                const segDownloaded = seg.downloadedBytes || Math.round(seg.progress * segTotal);
                return (
                  <SegmentCard
                    key={seg.id}
                    seg={seg}
                    segTotal={segTotal}
                    segDownloaded={segDownloaded}
                    isActive={seg.active && seg.progress < 1}
                    highlighted={activeHoverId === seg.id}
                    onHoverChange={handleCardHover}
                    t={t}
                  />
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Bottom action row: Stop on left, Show Details on right */}
      <div
        className="flex items-center justify-between pt-2 border-t border-[var(--border-color)]/60 mt-1"
        style={{ direction: 'ltr' }}
      >
        {/* Primary action: Stop / Resume / Finished */}
        {isDownloading ? (
          <button
            onClick={() => {
              void pauseTask(task.id);
            }}
            className="px-6 py-1.5 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] active:scale-95 text-white text-[11px] font-bold rounded-lg shadow-sm transition-all cursor-pointer min-w-[80px]"
          >
            {t('topbar_stop')}
          </button>
        ) : task.status === 'paused' || task.status === 'error' ? (
          <button
            onClick={() => {
              void resumeTask(task.id);
            }}
            className="px-6 py-1.5 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] active:scale-95 text-white text-[11px] font-bold rounded-lg shadow-sm transition-all cursor-pointer min-w-[80px]"
          >
            {t('progress_resume_btn')}
          </button>
        ) : (
          <div className="px-6 py-1.5 bg-[var(--bg-input)] border border-[var(--border-color)] text-[var(--text-muted)] text-[11px] font-bold select-none min-w-[80px] text-center rounded-lg">
            {t('progress_finished')}
          </div>
        )}

        {/* Show / Hide details � next to the Stop button, clearly visible */}
        <button
          onClick={() => {
            setDetailsCollapsed((v) => !v);
          }}
          className={`flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-bold rounded-lg border transition-all duration-150 cursor-pointer ${
            detailsCollapsed
              ? 'bg-[var(--bg-surface-elevated)] border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)]/60 hover:text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/5'
              : 'bg-[var(--accent-primary)]/10 border-[var(--accent-primary)]/50 text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/20'
          }`}
          title={detailsCollapsed ? t('progress_show_details') : t('progress_hide_details')}
        >
          <svg
            className={`w-3 h-3 transition-transform duration-200 ${detailsCollapsed ? '' : 'rotate-180'}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {detailsCollapsed ? t('progress_show_details') : t('progress_hide_details')}
        </button>
      </div>
    </div>
  );
};
