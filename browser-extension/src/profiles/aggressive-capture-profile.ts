import type { Settings } from '../contracts/settings.schema';

export const AGGRESSIVE_CAPTURE_MODE_VERSION = 2;

export const AGGRESSIVE_ALL_SITES_ORIGINS = ['<all_urls>'] as const;
export const AGGRESSIVE_REQUIRED_PERMISSIONS = ['downloads', 'webRequest', 'scripting', 'tabs'] as const;

export const AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE = {
  permissions: [...AGGRESSIVE_REQUIRED_PERMISSIONS] as string[],
  origins: [...AGGRESSIVE_ALL_SITES_ORIGINS] as string[],
};

export type AggressiveCapturePermissionStatus = {
  granted: boolean;
  hasAllSitesAccess: boolean;
  missingPermissions: string[];
  missingOrigins: string[];
};

export function summarizeAggressivePermissionGrant(result: { granted?: boolean; requested?: { permissions?: string[]; origins?: string[] } }): AggressiveCapturePermissionStatus {
  const requestedPermissions = result.requested?.permissions ?? AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions;
  const requestedOrigins = result.requested?.origins ?? AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins;
  const granted = Boolean(result.granted);
  return {
    granted,
    hasAllSitesAccess: granted && requestedOrigins.includes('<all_urls>'),
    missingPermissions: granted ? [] : requestedPermissions,
    missingOrigins: granted ? [] : requestedOrigins,
  };
}

export const AGGRESSIVE_CAPTURE_PROFILE = {
  id: 'aggressive-capture',
  label: 'Aggressive Capture Mode',
  version: AGGRESSIVE_CAPTURE_MODE_VERSION,
  description: 'Expands user-approved capture coverage with Chrome-style all-sites access while preserving local-only privacy boundaries.',
  drmGuard: false,
  privacyBoundary: 'No DRM bypass. No cookies, no Authorization headers, no browsing-history upload, and No hidden telemetry.',
  enabledFeatures: [
    'Chrome-style read/change site access on all websites after the user grants <all_urls>',
    'deep DOM and media scan',
    'network response-header capture when permission is granted',
    'downloads API observation when permission is granted',
    'low-confidence candidate visibility',
    'zero minimum file size filter',
    'HLS/DASH and media-element probing',
  ],
};

export function applyAggressiveCaptureDefaults(settings: Settings): Settings {
  return {
    ...settings,
    capture: {
      ...settings.capture,
      aggressiveMode: true,
      dom: true,
      network: true,
      downloads: true,
      hlsDash: true,
      mediaProbe: true,
      minFileSizeMB: 0,
      showLowConfidence: true,
    },
  };
}

export function disableAggressiveCapture(settings: Settings): Settings {
  return {
    ...settings,
    capture: {
      ...settings.capture,
      aggressiveMode: false,
    },
  };
}
