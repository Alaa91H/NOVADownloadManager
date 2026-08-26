import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initialSettings } from '../../../initialData';
import type { DownloadItem } from '../../../types/desktop-ui.types';

// All state referenced by the hoisted vi.mock factories must come from
// vi.hoisted (declared before the mocks run) — same pattern as the
// DetachedProgressWindow test.
const { tasksMock, noop, closeDialog } = vi.hoisted(() => ({
  tasksMock: [] as DownloadItem[],
  noop: vi.fn(),
  closeDialog: vi.fn(),
}));

vi.mock('../../../store/engineStore', () => ({
  useEngineStore: {
    getState: () => ({ refreshAdaptive: noop, refreshSegments: noop }),
  },
}));

// `initialSettings` stays a normal import and is read lazily inside the factory.

vi.mock('../../../store/selectors', () => ({
  useDialogData: () => ({ active: 'activeProgress', payload: null }),
  useTaskData: () => tasksMock,
  useTaskActions: () => ({ pauseTask: noop, resumeTask: noop }),
  useSettingsData: () => initialSettings,
  useSettingsActions: () => ({ updateSettings: noop }),
  useDialogActions: () => ({ closeDialog }),
  useEngineAdaptive: () => null,
  useI18n: () => (k: string) => {
    if (k === 'progress_seg_number') return 'Segment';
    if (k === 'progress_show_details') return 'Show details';
    if (k === 'progress_hide_details') return 'Hide details';
    if (k === 'progress_overall_progress') return 'Overall progress';
    if (k === 'progress_segment_distribution') return 'Segment distribution';
    if (k === 'progress_receiving') return 'Receiving';
    if (k === 'progress_complete') return 'Complete';
    if (k === 'progress_idle') return 'Idle';
    if (k === 'progress_seg_of') return 'of';
    if (k === 'progress_status_tab') return 'Status';
    if (k === 'progress_speed_tab') return 'Speed';
    if (k === 'progress_file_size') return 'File size';
    if (k === 'progress_downloaded') return 'Downloaded';
    if (k === 'progress_transfer_rate') return 'Rate';
    if (k === 'progress_time_left') return 'Time left';
    if (k === 'progress_elapsed') return 'Elapsed';
    if (k === 'progress_resume') return 'Resume';
    if (k === 'progress_status') return 'Status';
    if (k === 'progress_not_running') return 'Not running';
    if (k === 'progress_resume_btn') return 'Resume';
    if (k === 'progress_finished') return 'Finished';
    if (k === 'progress_hide_tab') return 'Hide tab';
    if (k === 'progress_use_global_speed_limit') return 'Use global limit';
    if (k === 'progress_max_speed') return 'Max speed';
    if (k === 'progress_active_connections') return 'Connections';
    if (k === 'progress_eta') return 'ETA';
    if (k === 'topbar_stop') return 'Stop';
    if (k === 'task_supported') return 'Supported';
    if (k === 'task_not_supported') return 'Not supported';
    return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  },
}));

import { ActiveProgressDialog } from '../ActiveProgressDialog';

const baseTask: DownloadItem = {
  id: 't1',
  name: 'file.bin',
  url: 'https://example.com/file.bin',
  fileType: 'other',
  status: 'downloading',
  sizeBytes: 3000,
  downloadedBytes: 1500,
  speedBytesPerSec: 1024,
  timeLeftSeconds: 10,
  elapsedSeconds: 2,
  dateAdded: '2026-01-01T00:00:00Z',
  category: 'other',
  queueId: 'main',
  connections: 3,
  resumable: true,
  savePath: '/tmp/file.bin',
  description: '',
  segments: [
    { id: 1, progress: 0.5, downloadedBytes: 500, totalBytes: 1000, active: true, speed: 512 },
    { id: 2, progress: 1, downloadedBytes: 1000, totalBytes: 1000, active: false, speed: 0 },
    { id: 3, progress: 0, downloadedBytes: 0, totalBytes: 1000, active: false, speed: 0 },
  ],
};

describe('ActiveProgressDialog — unified segment progress', () => {
  beforeEach(() => {
    tasksMock.length = 0;
    closeDialog.mockReset();
  });

  it('renders Finished as a button that dismisses a completed progress dialog', () => {
    tasksMock.push({
      ...baseTask,
      status: 'completed',
      downloadedBytes: baseTask.sizeBytes,
      speedBytesPerSec: 0,
      timeLeftSeconds: 0,
      segments: baseTask.segments.map((segment) => ({ ...segment, progress: 1, active: false, speed: 0 })),
    });
    render(<ActiveProgressDialog taskId="t1" />);

    const finished = screen.getByRole('button', { name: 'Finished' });
    expect(finished).toBeEnabled();
    fireEvent.click(finished);
    expect(closeDialog).toHaveBeenCalledTimes(1);
  });

  it('renders each segment card through the shared TaskProgressBar with the matching tone', () => {
    tasksMock.push(baseTask);
    render(<ActiveProgressDialog taskId="t1" />);

    // Expand the details to reveal the per-segment distribution cards.
    fireEvent.click(screen.getByText('Show details'));

    // Active segment → accent tone at 50% with a live head badge.
    const seg1 = screen.getByRole('progressbar', { name: 'Segment 1' });
    expect(seg1.getAttribute('aria-valuenow')).toBe('50');
    const seg1Fill = seg1.querySelector('[data-testid="progress-fill"]');
    expect(seg1Fill?.className).toContain('bg-[var(--accent-primary)]');
    expect(seg1Fill).toHaveStyle({ width: '50%' });
    // Completed segment → success tone at 100%, no head badge (not active).
    const seg2 = screen.getByRole('progressbar', { name: 'Segment 2' });
    expect(seg2.getAttribute('aria-valuenow')).toBe('100');
    const seg2Fill = seg2.querySelector('[data-testid="progress-fill"]');
    expect(seg2Fill?.className).toContain('bg-[var(--success)]/70');
    expect(seg2Fill).toHaveStyle({ width: '100%' });

    // Idle segment → muted tone at 0%, no head badge.
    const seg3 = screen.getByRole('progressbar', { name: 'Segment 3' });
    expect(seg3.getAttribute('aria-valuenow')).toBe('0');
    const seg3Fill = seg3.querySelector('[data-testid="progress-fill"]');
    expect(seg3Fill?.className).toContain('bg-[var(--text-secondary)]/30');
    expect(seg3Fill).toHaveStyle({ width: '0%' });

    // Only the active segment gets the live head badge (a sibling overlay of
    // its progressbar), sitting at its fill edge with the live percentage.
    const heads = screen.getAllByTestId('progress-head');
    expect(heads).toHaveLength(1);
    expect(heads[0]).toHaveTextContent('50%');
    // Centred on the fill edge — at 50% the badge sits halfway down the track.
    // (jsdom re-serializes clamp() — assert on the parts that matter.)
    expect(heads[0].style.left).toContain('50%');
    expect(heads[0].style.left).toContain('calc(100% - 15px)');
  });

  it('keeps the overall bar and the composite distribution bar consistent with the same tone map', () => {
    tasksMock.push(baseTask);
    render(<ActiveProgressDialog taskId="t1" />);

    // Overall bar is always visible without expanding details.
    const overall = screen.getByRole('progressbar', { name: 'file.bin' });
    expect(overall.getAttribute('aria-valuenow')).toBe('50');
    const overallFill = overall.querySelector('[data-testid="progress-fill"]');
    expect(overallFill?.className).toContain('bg-[var(--accent-primary)]');
    expect(overallFill).toHaveStyle({ width: '50%' });
  });

  it('renders the shared legend with real tone classes and live segment counts', () => {
    tasksMock.push(baseTask);
    render(<ActiveProgressDialog taskId="t1" />);

    // baseTask segments: 1 active (Receiving), 1 completed (Complete), 1 idle.
    const accent = screen.getByTestId('legend-head-accent');
    expect(accent.className).toContain('bg-[var(--accent-primary)]');
    expect(screen.getByText('Receiving')).toBeInTheDocument();
    const success = screen.getByTestId('legend-head-success');
    expect(success.className).toContain('bg-[var(--success)]/70');
    expect(screen.getByText('Complete')).toBeInTheDocument();
    const muted = screen.getByTestId('legend-head-muted');
    expect(muted.className).toContain('bg-[var(--text-secondary)]/30');
    expect(screen.getByText('Idle')).toBeInTheDocument();
    // All three states have a live count of 1 each.
    expect(screen.getAllByText('(1)')).toHaveLength(3);
  });

  it('renders a clean composite multi-connection bar without visible percentage badges', () => {
    tasksMock.push(baseTask);
    render(<ActiveProgressDialog taskId="t1" />);

    // The compact composite strip remains visible, but per-connection percent
    // pills are intentionally omitted so it shows only transfer cells.
    expect(screen.getByTestId('seg-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('seg-head')).not.toBeInTheDocument();

    // Keep the values available to assistive technology and hover details even
    // though they are no longer printed inside the narrow connection cells.
    expect(screen.getByRole('img', { name: 'Segment 1: 50%' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Segment 2: 100%' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Segment 3: 0%' })).toBeInTheDocument();
  });

  it('hovering a composite cell shows a rich tooltip and highlights its card', () => {
    tasksMock.push(baseTask);
    render(<ActiveProgressDialog taskId="t1" />);
    fireEvent.click(screen.getByText('Show details'));

    fireEvent.mouseEnter(screen.getByTestId('seg-cell-1'));

    // Rich tooltip: segment number, state, bytes, live speed and ETA.
    const tooltip = screen.getByTestId('seg-tooltip');
    expect(tooltip).toHaveTextContent('Segment 1');
    expect(tooltip).toHaveTextContent('Receiving');
    expect(tooltip).toHaveTextContent('500 B');
    expect(tooltip).toHaveTextContent('1000 B');
    expect(tooltip).toHaveTextContent('512 B/s');
    expect(tooltip).toHaveTextContent('ETA');
    expect(tooltip).toHaveTextContent('1s');

    // The matching card is lifted with the highlight ring; the others aren't.
    expect(screen.getByTestId('segment-card-1').className).toContain('ring-2');
    expect(screen.getByTestId('segment-card-2').className).not.toContain('ring-2');
    expect(screen.getByTestId('segment-card-3').className).not.toContain('ring-2');
  });

  it('hover linking follows the hovered segment and clears on leave', () => {
    tasksMock.push(baseTask);
    render(<ActiveProgressDialog taskId="t1" />);
    fireEvent.click(screen.getByText('Show details'));

    fireEvent.mouseEnter(screen.getByTestId('seg-cell-1'));
    expect(screen.getByTestId('seg-tooltip')).toHaveTextContent('Segment 1');
    expect(screen.getByTestId('segment-card-1').className).toContain('ring-2');

    // Move to segment 3 — tooltip AND highlight follow.
    fireEvent.mouseEnter(screen.getByTestId('seg-cell-3'));
    expect(screen.getByTestId('seg-tooltip')).toHaveTextContent('Segment 3');
    expect(screen.getByTestId('seg-tooltip')).toHaveTextContent('Idle');
    expect(screen.getByTestId('segment-card-3').className).toContain('ring-2');
    expect(screen.getByTestId('segment-card-1').className).not.toContain('ring-2');

    // Leaving the bar (cleared at the container level) clears tooltip and
    // highlight — while moving between adjacent cells keeps the tooltip gliding.
    fireEvent.mouseLeave(screen.getByTestId('seg-bar'));
    expect(screen.queryByTestId('seg-tooltip')).not.toBeInTheDocument();
    expect(screen.getByTestId('segment-card-3').className).not.toContain('ring-2');
  });

  it('hovering a card highlights its composite cell without showing the tooltip', () => {
    tasksMock.push(baseTask);
    render(<ActiveProgressDialog taskId="t1" />);
    fireEvent.click(screen.getByText('Show details'));

    // Hovering the card links back to the bar cell (no tooltip — it is
    // reserved for the bar cells).
    fireEvent.mouseEnter(screen.getByTestId('segment-card-2'));
    expect(screen.getByTestId('seg-cell-2').className).toContain('ring-1');
    expect(screen.queryByTestId('seg-tooltip')).not.toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByTestId('segment-card-2'));
    expect(screen.getByTestId('seg-cell-2').className).not.toContain('ring-1');
  });

  it('clamps the tooltip inside the bar even for the outermost cells', () => {
    const many: DownloadItem = {
      ...baseTask,
      segments: Array.from({ length: 12 }, (_, i) => ({
        id: i + 1,
        progress: 0.5,
        downloadedBytes: 500,
        totalBytes: 1000,
        active: i === 0,
        speed: i === 0 ? 512 : 0,
      })),
    };
    tasksMock.push(many);
    render(<ActiveProgressDialog taskId="t1" />);

    // The outermost cell would push the tooltip off the bar — the clamp keeps
    // its anchor between 10% and 90% of the bar width.
    fireEvent.mouseEnter(screen.getByTestId('seg-cell-12'));
    const left = parseFloat(screen.getByTestId('seg-tooltip').style.left);
    expect(left).toBeGreaterThanOrEqual(10);
    expect(left).toBeLessThanOrEqual(90);

    fireEvent.mouseEnter(screen.getByTestId('seg-cell-1'));
    const leftFirst = parseFloat(screen.getByTestId('seg-tooltip').style.left);
    expect(leftFirst).toBeGreaterThanOrEqual(10);
    expect(leftFirst).toBeLessThanOrEqual(90);
  });

  it('updates a composite cell fill without rendering a percentage badge', () => {
    const moving: DownloadItem = {
      ...baseTask,
      segments: [
        { id: 1, progress: 0.2, downloadedBytes: 200, totalBytes: 1000, active: true, speed: 512 },
        { id: 2, progress: 0, downloadedBytes: 0, totalBytes: 1000, active: false, speed: 0 },
      ],
    };
    tasksMock.push(moving);
    const { rerender } = render(<ActiveProgressDialog taskId="t1" />);

    const cell = screen.getByTestId('seg-cell-1');
    const fillBefore = cell.querySelector('div[style]') as HTMLDivElement;
    expect(fillBefore.style.width).toBe('20%');
    expect(screen.queryByTestId('seg-head')).not.toBeInTheDocument();

    moving.segments[0] = { ...moving.segments[0], progress: 0.9, downloadedBytes: 900 };
    rerender(<ActiveProgressDialog taskId="t1" />);
    const fillAfter = screen.getByTestId('seg-cell-1').querySelector('div[style]') as HTMLDivElement;
    expect(fillAfter.style.width).toBe('90%');
    expect(screen.queryByTestId('seg-head')).not.toBeInTheDocument();
  });
});
