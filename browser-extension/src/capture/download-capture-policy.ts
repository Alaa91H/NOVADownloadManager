export type DownloadCaptureSettingsSnapshot = {
  enabled?: boolean;
  capture?: {
    downloads?: boolean;
    aggressiveMode?: boolean;
    takeoverEnabled?: boolean;
  };
};

/**
 * Determines whether the document-start content script may prevent a browser
 * download and hand its URL to NOVA. This is intentionally aligned with the
 * background Downloads API path: a user who disables both download capture
 * and aggressive mode must retain the browser's normal click behaviour.
 *
 * Missing capture fields remain permissive for compatibility with settings
 * records written before those fields existed; the SettingsStore later
 * normalizes them to the documented defaults.
 */
export function isContentDownloadCaptureEnabled(settings: DownloadCaptureSettingsSnapshot | undefined): boolean {
  if (!settings) return true;
  if (settings.enabled === false) return false;

  const capture = settings.capture;
  if (!capture) return true;

  const aggressive = capture.aggressiveMode === true;
  const downloadsRequested = capture.downloads !== false || aggressive;
  const takeoverRequested = capture.takeoverEnabled !== false || aggressive;
  return downloadsRequested && takeoverRequested;
}
