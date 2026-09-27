import { describe, it, expect } from 'vitest';
import { taskProgressInfo } from '../progressUtils';

describe('taskProgressInfo', () => {
  it('returns a real percentage when the total size is known', () => {
    expect(taskProgressInfo({ sizeBytes: 100, downloadedBytes: 25, status: 'downloading' })).toEqual({
      known: true,
      percent: 25,
      indeterminate: false,
      percentLabel: '25%',
    });
  });

  it('caps the percentage at 100 for a completed download', () => {
    expect(taskProgressInfo({ sizeBytes: 100, downloadedBytes: 150, status: 'completed' })).toEqual({
      known: true,
      percent: 100,
      indeterminate: false,
      percentLabel: '100%',
    });
  });

  it('is indeterminate while downloading with an unknown total size', () => {
    // The core "0% then 100%" fix: when the engine has not yet reported a
    // size, the UI must NOT render a misleading 0% — it renders an animated
    // indeterminate bar instead, with a "…" label.
    expect(taskProgressInfo({ sizeBytes: 0, downloadedBytes: 12, status: 'downloading' })).toEqual({
      known: false,
      percent: 0,
      indeterminate: true,
      percentLabel: '…',
    });
  });

  it('is not indeterminate when not downloading (even with unknown size)', () => {
    expect(taskProgressInfo({ sizeBytes: 0, downloadedBytes: 0, status: 'queued' })).toEqual({
      known: false,
      percent: 0,
      indeterminate: false,
      percentLabel: '0%',
    });
    expect(taskProgressInfo({ sizeBytes: 0, downloadedBytes: 0, status: 'completed' })).toEqual({
      known: false,
      percent: 0,
      indeterminate: false,
      percentLabel: '0%',
    });
  });

  it('handles null/undefined tasks gracefully', () => {
    expect(taskProgressInfo(null)).toEqual({
      known: false,
      percent: 0,
      indeterminate: false,
      percentLabel: '0%',
    });
    expect(taskProgressInfo(undefined)).toEqual({
      known: false,
      percent: 0,
      indeterminate: false,
      percentLabel: '0%',
    });
  });

  it('rounds percentages to integers', () => {
    expect(taskProgressInfo({ sizeBytes: 3, downloadedBytes: 1, status: 'downloading' }).percent).toBe(33);
  });

  it('never reports a decreasing percentage across the unknown → known size transition', () => {
    // Simulated SSE stream: the engine starts the task with sizeBytes 0
    // (indeterminate bar), then discovers the size from the response headers
    // while downloadedBytes keeps growing. The displayed percentage must be
    // monotonic non-decreasing across the whole handoff — the engine freezes
    // sizeBytes once known, so the UI can never jump backward.
    const snapshots = [
      // Unknown size, still transferring: indeterminate bar.
      { sizeBytes: 0, downloadedBytes: 0, status: 'downloading' },
      { sizeBytes: 0, downloadedBytes: 512 * 1024, status: 'downloading' },
      // Headers arrive: size discovered (8 MiB), 1 MiB already on disk.
      { sizeBytes: 8 * 1024 * 1024, downloadedBytes: 1 * 1024 * 1024, status: 'downloading' },
      { sizeBytes: 8 * 1024 * 1024, downloadedBytes: 4 * 1024 * 1024, status: 'downloading' },
      { sizeBytes: 8 * 1024 * 1024, downloadedBytes: 8 * 1024 * 1024, status: 'completed' },
    ];
    let lastPercent = 0;
    let sawIndeterminate = false;
    for (const snapshot of snapshots) {
      const info = taskProgressInfo(snapshot);
      if (info.indeterminate) {
        sawIndeterminate = true;
        continue;
      }
      expect(info.percent).toBeGreaterThanOrEqual(lastPercent);
      lastPercent = info.percent;
    }
    expect(sawIndeterminate).toBe(true);
    expect(lastPercent).toBe(100);
  });
});
