import { describe, it, expect } from 'vitest';
import { computeScrollWindow } from '../useScrollWindow';

describe('computeScrollWindow', () => {
  it('renders everything for small lists (below threshold)', () => {
    const w = computeScrollWindow({ scrollTop: 0, viewportHeight: 600, itemCount: 50, itemHeight: 28 });
    expect(w.windowed).toBe(false);
    expect(w.start).toBe(0);
    expect(w.end).toBe(50);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe(0);
  });

  it('renders everything when the list fits the viewport', () => {
    // 200 items × 20px = 4000px > 600px viewport, but minVirtualize is 150
    // and itemCount 200 → windowed. Here we force itemCount above threshold
    // with a small total height to check the "fits viewport" branch instead.
    const w = computeScrollWindow({
      scrollTop: 0,
      viewportHeight: 600,
      itemCount: 200,
      itemHeight: 2,
      minVirtualize: 150,
    });
    expect(w.windowed).toBe(false);
    expect(w.end).toBe(200);
  });

  it('returns an empty window for zero items', () => {
    const w = computeScrollWindow({ scrollTop: 0, viewportHeight: 600, itemCount: 0, itemHeight: 28 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(0);
    expect(w.windowed).toBe(false);
  });

  it('windows large lists and preserves total height', () => {
    const itemCount = 10_000;
    const itemHeight = 28;
    const viewportHeight = 600;
    const w = computeScrollWindow({ scrollTop: 0, viewportHeight, itemCount, itemHeight, overscan: 10 });

    expect(w.windowed).toBe(true);
    expect(w.start).toBe(0);
    expect(w.end).toBeGreaterThan(0);
    expect(w.end).toBeLessThan(itemCount);
    // Top pad + rendered slice + bottom pad must equal the full list height.
    const rendered = w.end - w.start;
    expect(w.padTop + rendered * itemHeight + w.padBottom).toBe(itemCount * itemHeight);
  });

  it('windows at the correct scroll offset (middle of the list)', () => {
    const itemCount = 10_000;
    const itemHeight = 28;
    const viewportHeight = 600;
    const scrollTop = 250_000; // ≈ row 8928
    const w = computeScrollWindow({ scrollTop, viewportHeight, itemCount, itemHeight, overscan: 10 });

    expect(w.windowed).toBe(true);
    // Window should be centered around the scroll position.
    const visibleStart = Math.floor(scrollTop / itemHeight);
    expect(w.start).toBeLessThanOrEqual(visibleStart);
    expect(w.end).toBeGreaterThan(visibleStart);
    expect(w.padTop + (w.end - w.start) * itemHeight + w.padBottom).toBe(itemCount * itemHeight);
  });

  it('clamps the window at the end of the list', () => {
    const itemCount = 10_000;
    const itemHeight = 28;
    const viewportHeight = 600;
    const scrollTop = 1_000_000; // way past the last row
    const w = computeScrollWindow({ scrollTop, viewportHeight, itemCount, itemHeight, overscan: 10 });

    expect(w.windowed).toBe(true);
    expect(w.end).toBe(itemCount);
    expect(w.padBottom).toBe(0);
    expect(w.start).toBeLessThan(itemCount);
  });

  it('never exceeds the list bounds', () => {
    for (let scrollTop = 0; scrollTop <= 300_000; scrollTop += 13_333) {
      const w = computeScrollWindow({
        scrollTop,
        viewportHeight: 400,
        itemCount: 5_000,
        itemHeight: 24,
        overscan: 5,
      });
      expect(w.start).toBeGreaterThanOrEqual(0);
      expect(w.end).toBeLessThanOrEqual(5_000);
      expect(w.padTop).toBe(w.start * 24);
      expect(w.padBottom).toBe((5_000 - w.end) * 24);
    }
  });
});
