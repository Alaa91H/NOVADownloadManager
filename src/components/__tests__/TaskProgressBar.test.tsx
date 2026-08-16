import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TaskProgressBar, ProgressLegend, progressToneFillClass } from '../primitives/TaskProgressBar';

describe('TaskProgressBar — indeterminate → percentage transition', () => {
  it('cross-fades the sweep out instead of swapping elements (no visual backward jump)', () => {
    // Phase 1: size unknown — the fill is mounted at 0% and the sweep is
    // fully visible. The fill being present even now is what lets the width
    // animate later instead of the bar collapsing from a full-width sweep.
    const { rerender } = render(
      <TaskProgressBar progress={{ known: false, percent: 0, indeterminate: true, percentLabel: '…' }} active />,
    );
    const fillBefore = screen.getByTestId('progress-fill');
    const sweepBefore = screen.getByTestId('progress-sweep');
    expect(fillBefore).toHaveStyle({ width: '0%' });
    expect(sweepBefore.className).toContain('opacity-100');

    // Phase 2: the engine discovers the size from headers — 8 of 100 MB done.
    // The SAME nodes stay mounted: the sweep fades to 0 and the fill (which
    // was already in the DOM) transitions its width to the real percentage.
    rerender(
      <TaskProgressBar progress={{ known: true, percent: 8, indeterminate: false, percentLabel: '8%' }} active />,
    );
    expect(screen.getByTestId('progress-fill')).toBe(fillBefore);
    expect(screen.getByTestId('progress-sweep')).toBe(sweepBefore);
    expect(fillBefore).toHaveStyle({ width: '8%' });
    expect(sweepBefore.className).toContain('opacity-0');
    expect(screen.getByText('8%')).toBeInTheDocument();
  });

  it('keeps the width transition classes so the percentage glides, never snaps', () => {
    render(
      <TaskProgressBar progress={{ known: true, percent: 42, indeterminate: false, percentLabel: '42%' }} active />,
    );
    const fill = screen.getByTestId('progress-fill');
    // transition-all + duration-300 is what makes the 0% → real-percent
    // handoff animate instead of teleporting.
    expect(fill.className).toContain('transition-all');
    expect(fill.className).toContain('duration-300');
    expect(fill).toHaveStyle({ width: '42%' });
  });

  it('renders track-only when showLabel is false (compact statusbar chip)', () => {
    const { rerender } = render(
      <TaskProgressBar
        progress={{ known: true, percent: 63, indeterminate: false, percentLabel: '63%' }}
        active
        showLabel={false}
      />,
    );
    // The percent text must not be rendered, but the bar stays mounted and
    // animated so the chip still shows live progress.
    expect(screen.queryByText('63%')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '63');
    expect(screen.getByTestId('progress-fill')).toHaveStyle({ width: '63%' });

    // Indeterminate phase keeps the sweep visible in the label-less variant.
    rerender(
      <TaskProgressBar
        progress={{ known: false, percent: 0, indeterminate: true, percentLabel: '…' }}
        active
        showLabel={false}
      />,
    );
    expect(screen.getByTestId('progress-sweep').className).toContain('opacity-100');
  });

  it('applies the tone-specific fill colour (accent/success/muted)', () => {
    const { rerender } = render(
      <TaskProgressBar
        progress={{ known: true, percent: 40, indeterminate: false, percentLabel: '40%' }}
        active
        tone="accent"
      />,
    );
    expect(screen.getByTestId('progress-fill').className).toContain(progressToneFillClass.accent);

    rerender(
      <TaskProgressBar
        progress={{ known: true, percent: 100, indeterminate: false, percentLabel: '100%' }}
        active={false}
        tone="success"
      />,
    );
    expect(screen.getByTestId('progress-fill').className).toContain(progressToneFillClass.success);

    rerender(
      <TaskProgressBar
        progress={{ known: true, percent: 0, indeterminate: false, percentLabel: '0%' }}
        active={false}
        tone="muted"
      />,
    );
    expect(screen.getByTestId('progress-fill').className).toContain(progressToneFillClass.muted);
  });

  it('shows a live head badge at the fill edge for an active determinate segment', () => {
    const { rerender } = render(
      <TaskProgressBar
        progress={{ known: true, percent: 42, indeterminate: false, percentLabel: '42%' }}
        active
        headLabel="42%"
      />,
    );
    const head = screen.getByTestId('progress-head');
    expect(head).toHaveTextContent('42%');
    expect(head).toHaveAttribute('aria-hidden', 'true');
    // The badge is centred on the download head and clamped to the track edges.
    // (jsdom re-serializes clamp() — assert on the parts that matter.)
    expect(head.style.left).toContain('42%');
    expect(head.style.left).toContain('calc(100% - 15px)');

    // It moves with the percentage as bytes arrive — the SAME node glides via
    // its left transition rather than being remounted at the new position.
    const headBefore = screen.getByTestId('progress-head');
    rerender(
      <TaskProgressBar
        progress={{ known: true, percent: 78, indeterminate: false, percentLabel: '78%' }}
        active
        headLabel="78%"
      />,
    );
    expect(screen.getByTestId('progress-head')).toBe(headBefore);
    expect(headBefore).toHaveTextContent('78%');
    expect(headBefore.style.left).toContain('78%');
  });

  it('never lets the head badge overhang the track — clamps at 0% and 100%', () => {
    const { rerender } = render(
      <TaskProgressBar
        progress={{ known: true, percent: 0, indeterminate: false, percentLabel: '0%' }}
        active
        headLabel="0%"
      />,
    );
    expect(screen.getByTestId('progress-head').style.left).toContain('0%');
    expect(screen.getByTestId('progress-head').style.left).toContain('calc(100% - 15px)');

    rerender(
      <TaskProgressBar
        progress={{ known: true, percent: 100, indeterminate: false, percentLabel: '100%' }}
        active
        headLabel="100%"
      />,
    );
    expect(screen.getByTestId('progress-head').style.left).toContain('100%');
    expect(screen.getByTestId('progress-head').style.left).toContain('calc(100% - 15px)');
    // The bar itself is honest at 100% — the fill never exceeds it either.
    expect(screen.getByTestId('progress-fill')).toHaveStyle({ width: '100%' });
  });

  it('hides the head badge when indeterminate, inactive, or unlabelled', () => {
    const { rerender } = render(
      <TaskProgressBar
        progress={{ known: false, percent: 0, indeterminate: true, percentLabel: '…' }}
        active
        headLabel="…"
      />,
    );
    expect(screen.queryByTestId('progress-head')).not.toBeInTheDocument();

    rerender(
      <TaskProgressBar
        progress={{ known: true, percent: 42, indeterminate: false, percentLabel: '42%' }}
        active={false}
        headLabel="42%"
      />,
    );
    expect(screen.queryByTestId('progress-head')).not.toBeInTheDocument();

    rerender(
      <TaskProgressBar progress={{ known: true, percent: 42, indeterminate: false, percentLabel: '42%' }} active />,
    );
    expect(screen.queryByTestId('progress-head')).not.toBeInTheDocument();
  });

  it('honours an explicit aria-label for track-only renderers', () => {
    render(
      <TaskProgressBar
        progress={{ known: false, percent: 0, indeterminate: true, percentLabel: '…' }}
        active
        showLabel={false}
        ariaLabel="My download.exe"
      />,
    );
    // The indeterminate bar has no numeric value, so the caller-supplied label
    // is what screen readers announce instead of nothing.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', 'My download.exe');
  });

  it('renders legend entries with mini head badges tinted by the real tone map', () => {
    render(
      <ProgressLegend
        entries={[
          { tone: 'accent', label: 'Receiving', count: 2 },
          { tone: 'success', label: 'Complete', count: 1 },
          { tone: 'muted', label: 'Idle', count: 1 },
        ]}
      />,
    );

    // Each tone renders a mini head-badge pill whose class comes from the
    // shared map — so the legend can never drift from the bars' colours.
    const accent = screen.getByTestId('legend-head-accent');
    expect(accent.className).toContain(progressToneFillClass.accent);
    const success = screen.getByTestId('legend-head-success');
    expect(success.className).toContain(progressToneFillClass.success);
    const muted = screen.getByTestId('legend-head-muted');
    expect(muted.className).toContain(progressToneFillClass.muted);

    // Live counts render next to the labels.
    expect(screen.getByText('Receiving')).toBeInTheDocument();
    expect(screen.getByText('(2)')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
    // Success and muted both count 1 — the legend shows each count live.
    expect(screen.getAllByText('(1)')).toHaveLength(2);
    expect(screen.getByText('Idle')).toBeInTheDocument();

    // Decorative pills stay out of the accessibility tree.
    expect(accent).toHaveAttribute('aria-hidden', 'true');
  });

  it('pulses the live legend entry while downloading and stays static otherwise', () => {
    const { rerender } = render(
      <ProgressLegend
        entries={[
          { tone: 'accent', label: 'Receiving', count: 2, live: true },
          { tone: 'success', label: 'Complete', count: 1 },
        ]}
      />,
    );
    expect(screen.getByTestId('legend-head-accent').className).toContain('animate-pulse');
    expect(screen.getByTestId('legend-head-success').className).not.toContain('animate-pulse');

    // When the transfer stops, the pulse is dropped — honest about being idle.
    rerender(
      <ProgressLegend
        entries={[
          { tone: 'accent', label: 'Receiving', count: 2, live: false },
          { tone: 'success', label: 'Complete', count: 1 },
        ]}
      />,
    );
    expect(screen.getByTestId('legend-head-accent').className).not.toContain('animate-pulse');
  });

  it('exposes the determinate bar as an accessible progressbar and hides the sweep', () => {
    const { rerender } = render(
      <TaskProgressBar progress={{ known: true, percent: 42, indeterminate: false, percentLabel: '42%' }} active />,
    );
    const track = screen.getByRole('progressbar');
    expect(track).toHaveAttribute('aria-valuenow', '42');
    expect(track).toHaveAttribute('aria-valuemin', '0');
    expect(track).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByTestId('progress-sweep')).toHaveAttribute('aria-hidden', 'true');

    // Indeterminate: no numeric value to announce (screen readers get nothing
    // instead of a bogus "0%").
    rerender(
      <TaskProgressBar progress={{ known: false, percent: 0, indeterminate: true, percentLabel: '…' }} active />,
    );
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });
});
