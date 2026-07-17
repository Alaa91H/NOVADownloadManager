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
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${String(h)}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${String(m)}m ${String(s).padStart(2, '0')}s`;
  return `${String(s)}s`;
};
