/**
 * Unified formatting utilities for the entire NOVA frontend.
 *
 * This is the single source of truth for all byte/speed/time formatting.
 * Previously these functions lived in initialData.ts (a settings-data file)
 * and were re-exported from taskTableUtils.tsx — now they have one home.
 */

/** Format a byte count into human-readable units (B, KB, MB, GB, TB). */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes)) return 'Unknown';
  if (bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let temp = bytes;
  while (temp >= k && i < sizes.length - 1) {
    temp /= k;
    i += 1;
  }
  return `${String(parseFloat(temp.toFixed(2)))} ${sizes[i]}`;
};

/** Format a speed (bytes/sec) into human-readable units with -- for zero. */
export const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec <= 0) return '--';
  if (!Number.isFinite(bytesPerSec)) return '--';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  let temp = bytesPerSec;
  while (temp >= k && i < sizes.length - 1) {
    temp /= k;
    i += 1;
  }
  return `${String(parseFloat(temp.toFixed(1)))} ${sizes[i]}`;
};

/** Format remaining time (seconds) into human-readable with -- for zero. */
export const formatTimeLeft = (seconds: number): string => {
  if (seconds <= 0) return '--';
  if (!Number.isFinite(seconds)) return '--';
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${String(minutes)}m ${String(remainingSeconds)}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours)}h ${String(remainingMinutes)}m`;
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
 * The single canonical error-message formatter for the entire frontend.
 */
export function extractErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}
