import type { DownloadStatus } from '../types/desktop-ui.types';

/** Lifecycle states that still own active engine work or a queue slot. */
const ACTIVE_STATUSES = new Set<DownloadStatus>([
  'preparing',
  'probing',
  'downloading',
  'pausing',
  'stopping',
  'retrying',
  'recovering',
  'verifying',
  'finalizing',
]);

/** States where a user stop/pause request can still be safely accepted. */
const PAUSABLE_STATUSES = new Set<DownloadStatus>([
  'preparing',
  'probing',
  'downloading',
  'retrying',
  'recovering',
]);

/** States that can be resumed without a destructive redownload. */
const RESUMABLE_STATUSES = new Set<DownloadStatus>([
  'paused',
  'queued',
  'error',
  'interrupted',
]);

export const isTaskActiveStatus = (status: DownloadStatus): boolean => ACTIVE_STATUSES.has(status);

export const isTaskPausableStatus = (status: DownloadStatus): boolean => PAUSABLE_STATUSES.has(status);

export const isTaskResumableStatus = (status: DownloadStatus): boolean => RESUMABLE_STATUSES.has(status);

/** Only this phase is expected to have meaningful live transfer speed/ETA. */
export const isTaskReceivingBytes = (status: DownloadStatus): boolean => status === 'downloading';
