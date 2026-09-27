/**
 * Shared progress computation for every task progress renderer.
 *
 * The engine reports `sizeBytes` and `downloadedBytes` live via SSE. When the
 * total size is unknown (0) — e.g. a fast-path download whose preflight is
 * still running, or a chunked/streaming response with no Content-Length —
 * a percentage is meaningless. Professional download managers render an
 * indeterminate (animated) bar in that state instead of a fake "0%".
 *
 * All progress renderers (TaskTable, TaskCardList, StatusBar, dialogs,
 * scheduler tab, detached progress window) must use this single helper so the
 * behaviour stays consistent everywhere.
 */

export interface TaskProgressInfo {
  /** True when the total size is known and `percent` is meaningful. */
  known: boolean;
  /** Integer percentage 0..100 (only meaningful when `known` is true). */
  percent: number;
  /** True while actively downloading with an unknown total size. */
  indeterminate: boolean;
  /** Ready-to-render label: `…` when indeterminate, otherwise `NN%`. */
  percentLabel: string;
}

export interface TaskProgressLike {
  sizeBytes?: number;
  downloadedBytes?: number;
  status?: string;
}

export function taskProgressInfo(task: TaskProgressLike | null | undefined): TaskProgressInfo {
  const size = task?.sizeBytes ?? 0;
  const downloaded = task?.downloadedBytes ?? 0;
  const known = size > 0;
  const percent = known ? Math.min(100, Math.max(0, Math.round((downloaded / size) * 100))) : 0;
  const indeterminate = !known && task?.status === 'downloading';
  const percentLabel = indeterminate ? '…' : String(percent) + '%';
  return { known, percent, indeterminate, percentLabel };
}
