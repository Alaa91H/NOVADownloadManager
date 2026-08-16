import type { TaskProgressInfo } from '../../utils/progressUtils';

/** Fill colour variants — accent (active), success (completed), muted (idle). */
export type ProgressTone = 'accent' | 'success' | 'muted';

/**
 * Fill classes per tone, exported so every surface (overall bars, per-segment
 * cards, composite distribution bar) shares the exact same colours instead of
 * re-declaring them in each renderer.
 */
export const progressToneFillClass: Record<ProgressTone, string> = {
  accent: 'bg-[var(--accent-primary)]',
  success: 'bg-[var(--success)]/70',
  muted: 'bg-[var(--text-secondary)]/30',
};

/** Half the download-head badge width in px — the badge is centred on the
 *  download head and clamped so it never overhangs its track at 0% or 100%. */
const PROGRESS_HEAD_HALF_WIDTH = 15;

/** One row of the shared legend: a tone from the exported map plus its
 *  localised label and, optionally, a live count and a "live" pulse. */
export interface ProgressLegendEntry {
  tone: ProgressTone;
  label: string;
  count?: number;
  live?: boolean;
}

interface ProgressLegendProps {
  entries: ProgressLegendEntry[];
  /** Container layout/typography overrides (defaults to a muted small row). */
  className?: string;
}

/**
 * The single legend used wherever a composite progress breakdown is shown. Each
 * entry renders a MINI head-badge pill tinted by the same exported tone map the
 * bars actually use (`progressToneFillClass`), so the legend can never drift
 * from the real palette — adding/renaming a tone updates every legend at once.
 * The pills are decorative duplicates of the fills, so they are hidden from
 * assistive tech; the label text carries the meaning.
 */
export function ProgressLegend({ entries, className }: ProgressLegendProps) {
  return (
    <div className={`flex items-center gap-3 text-[10px] text-[var(--text-muted)] ${className ?? ''}`}>
      {entries.map((entry) => (
        <span key={entry.tone} className="flex items-center gap-1">
          <span
            data-testid={`legend-head-${entry.tone}`}
            aria-hidden="true"
            className={`inline-flex items-center justify-center min-w-[22px] h-[11px] px-0.5 rounded-full border border-[var(--border-color)] shadow-sm ${progressToneFillClass[entry.tone]} ${
              entry.live ? 'animate-pulse' : ''
            }`}
          >
            <span className="w-1 h-1 rounded-full bg-white/80" />
          </span>
          {entry.label}
          {typeof entry.count === 'number' && <span className="font-mono">({entry.count})</span>}
        </span>
      ))}
    </div>
  );
}

interface ProgressHeadBadgeProps {
  /** Head position as a percentage (0–100), clamped to the track bounds. */
  percent: number;
  /** Live label rendered inside the pill (e.g. `'42%'`). */
  label: string;
  /** True while the transfer is live — adds a subtle pulse. Default `true`. */
  active?: boolean;
  /** testid override so surfaces can query their own badges distinctly. */
  dataTestId?: string;
}

/**
 * The single download-head badge used everywhere a progress surface needs to
 * show where bytes are arriving. It rides the leading edge of the fill via the
 * shared clamp math and glides with `transition-[left]`, never overhanging its
 * track at 0% or 100%. The pill styling lives here once, so the card badges and
 * the composite distribution-bar markers can never drift apart. It is a live
 * duplicate of the fill edge, so it is hidden from assistive tech — callers
 * must announce the value on the track itself (the shared bar does via
 * `aria-valuenow`; the composite cells carry an `aria-label`).
 */
export function ProgressHeadBadge({
  percent,
  label,
  active = true,
  dataTestId = 'progress-head',
}: ProgressHeadBadgeProps) {
  return (
    <div
      data-testid={dataTestId}
      aria-hidden="true"
      className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 pointer-events-none flex items-center justify-center min-w-[30px] h-[14px] px-1 whitespace-nowrap rounded-full bg-[var(--bg-surface-elevated)] border border-[var(--border-color)] shadow-sm transition-[left] duration-300 ${
        active ? 'animate-pulse' : ''
      }`}
      style={{
        left: `clamp(${String(PROGRESS_HEAD_HALF_WIDTH)}px, ${String(percent)}%, calc(100% - ${String(PROGRESS_HEAD_HALF_WIDTH)}px))`,
      }}
    >
      <span className="text-[8px] font-mono font-bold text-[var(--accent-primary)]">{label}</span>
    </div>
  );
}

interface TaskProgressBarProps {
  progress: TaskProgressInfo;
  /** True while the task is actively downloading (pulse + glow on the fill). */
  active: boolean;
  /** Fill colour variant — defaults to `accent`. */
  tone?: ProgressTone;
  /**
   * Live label for the download-head badge (e.g. `'42%'` or a byte count).
   * Only rendered while `active` and determinate — the badge rides the leading
   * edge of the fill so the user sees exactly where bytes are arriving.
   */
  headLabel?: string;
  /** Track height class — `h-1.5` for table rows, `h-2` for cards. */
  trackClass?: string;
  /** Label typography class. */
  labelClass?: string;
  /** Gap between the track and the label. */
  gapClass?: string;
  /** False to render the track only (e.g. compact statusbar chips). */
  showLabel?: boolean;
  /** Overrides the progressbar's accessible name (used by track-only renderers). */
  ariaLabel?: string;
}

/**
 * Shared progress bar for every task renderer (table row, card, etc.).
 *
 * The indeterminate → percentage handoff is a smooth cross-fade, never a
 * hard element swap:
 *  - the determinate fill is ALWAYS mounted, so its width is animated by the
 *    CSS `transition-all` when the engine discovers the size (0% → real
 *    percentage), and it keeps animating as downloaded bytes grow;
 *  - the indeterminate sweep is overlaid on top and fades out via
 *    `transition-opacity` the moment the size becomes known.
 *
 * Because the fill is always present and the sweep only fades, the bar never
 * visually collapses from a full-width sweep to a small real percentage — the
 * exact "backward jump" users saw when the old code swapped the two elements.
 */
export function TaskProgressBar({
  progress,
  active,
  tone = 'accent',
  headLabel,
  trackClass = 'h-1.5',
  labelClass = 'text-[9px] font-bold',
  gapClass = 'gap-1.5',
  showLabel = true,
  ariaLabel,
}: TaskProgressBarProps) {
  const { percent, indeterminate, percentLabel } = progress;
  // The head badge is meaningful only while actively receiving bytes with a
  // known total; it is a live duplicate of the fill edge, so hide it from
  // assistive tech (the progressbar already announces the value).
  const showHead = headLabel !== undefined && active && !indeterminate;
  return (
    <div className={`flex items-center ${gapClass}`}>
      <div className="relative flex-1 min-w-0">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : percent}
          aria-label={ariaLabel ?? (indeterminate ? undefined : percentLabel)}
          className={`relative w-full progress-track ${trackClass} bg-[var(--bg-surface)] dark:bg-[var(--bg-surface-elevated)] rounded-full overflow-hidden border border-[var(--border-color)]`}
        >
          {/* Determinate fill — always mounted so the width can transition. */}
          <div
            data-testid="progress-fill"
            className={`absolute left-0 top-0 bottom-0 progress-fill rounded-full ${progressToneFillClass[tone]} transition-all duration-300 ${
              active ? 'accent-glow' : ''
            }`}
            style={{ width: `${String(indeterminate ? 0 : percent)}%` }}
          >
            {active && <div className="absolute inset-0 bg-white/20 animate-pulse rounded-full" />}
          </div>
          {/* Indeterminate sweep — fades out smoothly once the size is known. */}
          <div
            data-testid="progress-sweep"
            aria-hidden="true"
            className={`progress-indeterminate-bar pointer-events-none transition-opacity duration-300 ${
              indeterminate ? 'opacity-100' : 'opacity-0'
            }`}
          />
        </div>
        {/* Download-head badge — centred on the fill edge, clamped so it never
            overhangs the track: at 0% it hugs the left edge, at 100% the right. */}
        {showHead && <ProgressHeadBadge percent={percent} label={headLabel} />}
      </div>
      {showLabel && <span className={`text-[var(--text-secondary)] ${labelClass}`}>{percentLabel}</span>}
    </div>
  );
}
