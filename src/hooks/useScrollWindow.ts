/**
 * Hand-rolled scroll windowing for fixed-height lists.
 *
 * Keeps the DOM node count constant for very large task lists (10k+) by
 * rendering only the visible slice plus a small overscan, while preserving
 * the total scroll height with top/bottom spacers. The math is exact for
 * fixed-height items (the desktop table uses `height: var(--row-height)`).
 *
 * `computeScrollWindow` is pure and unit-tested; the hook adds a scroll /
 * resize listener over a container ref.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Reactively read a CSS custom property from `:root` (e.g. `--row-height`).
 * The density/theme attributes are applied by an effect after first paint, so
 * a one-shot read during render can go stale. Observing the attribute changes
 * guarantees the window math always tracks the applied slot height.
 */
export function useCssLengthVar(name: string): number {
  const [value, setValue] = useState(() => readCssLength(name));
  useEffect(() => {
    const update = () => {
      setValue(readCssLength(name));
    };
    update();
    const root = document.documentElement;
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(update) : null;
    mo?.observe(root, { attributes: true, attributeFilter: ['data-density', 'data-theme'] });
    return () => {
      mo?.disconnect();
    };
  }, [name]);
  return value;
}

function readCssLength(name: string): number {
  if (typeof document === 'undefined') return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export interface ScrollWindow {
  /** First index that should be rendered. */
  start: number;
  /** One past the last index that should be rendered. */
  end: number;
  /** Height of the top spacer (start * itemHeight). */
  padTop: number;
  /** Height of the bottom spacer ((itemCount - end) * itemHeight). */
  padBottom: number;
  /** True when the list was actually windowed (vs. fully rendered). */
  windowed: boolean;
}

export interface ComputeScrollWindowArgs {
  scrollTop: number;
  viewportHeight: number;
  itemCount: number;
  itemHeight: number;
  overscan?: number;
  /** Lists at or below this size always render fully. */
  minVirtualize?: number;
}

export function computeScrollWindow({
  scrollTop,
  viewportHeight,
  itemCount,
  itemHeight,
  overscan = 8,
  minVirtualize = 150,
}: ComputeScrollWindowArgs): ScrollWindow {
  if (itemCount <= 0 || itemHeight <= 0) {
    return { start: 0, end: Math.max(0, itemCount), padTop: 0, padBottom: 0, windowed: false };
  }
  const totalHeight = itemCount * itemHeight;
  // Small lists, lists that fit the viewport, or an unmeasured container
  // (clientHeight 0 before first layout) render fully — keeps select-all,
  // e2e row counts, and first-paint edge cases simple.
  if (itemCount <= minVirtualize || viewportHeight <= 0 || totalHeight <= viewportHeight) {
    return { start: 0, end: itemCount, padTop: 0, padBottom: 0, windowed: false };
  }

  const visible = Math.ceil(viewportHeight / itemHeight);
  const rawStart = Math.floor(scrollTop / itemHeight) - overscan;
  // Clamp so at least one screenful always renders (e.g. after a search/filter
  // shrinks the list while the container is still scrolled far down).
  const start = Math.max(0, Math.min(rawStart, Math.max(0, itemCount - visible)));
  const end = Math.min(itemCount, Math.ceil((scrollTop + viewportHeight) / itemHeight) + overscan);

  return {
    start,
    end,
    padTop: start * itemHeight,
    padBottom: Math.max(0, (itemCount - end) * itemHeight),
    windowed: true,
  };
}

/**
 * Tracks a container's scroll position and exposes `getWindow(itemCount,
 * itemHeight)` which returns the slice that should be in the DOM. Attach
 * `containerRef` to the scroll container that wraps the list.
 */
export function useScrollWindow() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // rAF-throttle: scroll/resize events can fire several times per frame;
    // collapsing them to one state update per animation frame keeps window
    // recomputation (and TaskTable re-renders) bounded while scrolling fast.
    let rafId = 0;
    const update = () => {
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight);
    };
    const schedule = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        update();
      });
    };
    update();

    el.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule);
      ro.observe(el);
    }

    return () => {
      el.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  }, []);

  const getWindow = useCallback(
    (itemCount: number, itemHeight: number, overscan = 8, minVirtualize = 150): ScrollWindow =>
      computeScrollWindow({ scrollTop, viewportHeight, itemCount, itemHeight, overscan, minVirtualize }),
    [scrollTop, viewportHeight],
  );

  return { containerRef, getWindow };
}
