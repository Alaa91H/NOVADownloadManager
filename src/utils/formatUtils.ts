import { formatSpeed as rawFormatSpeed, formatTimeLeft as rawFormatTimeLeft } from '../initialData';

/** Format speed with -- wrapper for zero/negative values */
export const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec <= 0) return '--';
  return rawFormatSpeed(bytesPerSec);
};

/** Format time remaining with -- wrapper for zero/negative values */
export const formatTimeLeft = (sec: number): string => {
  if (sec <= 0) return '--';
  return rawFormatTimeLeft(sec);
};

export const isMagnetLink = (url: string): boolean => url.trim().startsWith('magnet:');

/** Format elapsed time in HH:MM:SS or MM:SS format */
export const formatElapsed = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${String(h)}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${String(m)}m ${String(s).padStart(2, '0')}s`;
  return `${String(s)}s`;
};

/**
 * Extract a user-facing message from an unknown error value.
 *
 * This is the single canonical error-message formatter for the entire frontend.
 * Previously, the pattern `error instanceof Error ? error.message : '<fallback>'`
 * was hand-inlined at 17+ sites across the project. Now every catch block can
 * import and use `extractErrorMessage(e, 'fallback')` instead.
 */
export function extractErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}
