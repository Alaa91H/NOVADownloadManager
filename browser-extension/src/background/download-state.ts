export type DownloadStateNotice = 'paused' | 'complete' | 'failed' | null;

export type DownloadStateObservation = {
  itemState?: string;
  itemPaused?: boolean;
  itemCanResume?: boolean;
  deltaState?: string;
  deltaPaused?: boolean;
};

/**
 * Classifies a browser download event without treating every interruption as a
 * terminal failure. The browser's refreshed DownloadItem is authoritative when
 * available; delta fields are used as a safe fallback for event-only mocks.
 */
export function classifyDownloadNotice(observation: DownloadStateObservation): DownloadStateNotice {
  if (observation.itemState === 'complete' || observation.deltaState === 'complete') return 'complete';
  if (observation.itemPaused === true || observation.itemCanResume === true || observation.deltaPaused === true) {
    return 'paused';
  }
  if (observation.itemState === 'interrupted' || observation.deltaState === 'interrupted') return 'failed';
  return null;
}
