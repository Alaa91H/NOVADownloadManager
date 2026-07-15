/**
 * Capture Profiles — Phase 9.
 *
 * Five named profiles that control which permissions are requested and which
 * capture features are active. Profiles are additive: each profile includes
 * all capabilities of the one before it.
 *
 * Profiles do NOT bypass the store-compliance check. The store-safe profile
 * is the only one submitted to extension stores; others require sideloading or
 * optional permission grants.
 */

import type { Settings } from '../contracts/settings.schema';
import type { CaptureProfile } from '../contracts/settings.schema';
import { NOVA_LOOPBACK_ORIGIN_PATTERN } from '../security/permission-request-policy';

export type ProfileDescriptor = {
  id: CaptureProfile;
  label: string;
  description: string;
  privacyNote: string;
  requiredPermissions: string[];
  optionalPermissions: string[];
  optionalOrigins: string[];
};

export const CAPTURE_PROFILES: Record<CaptureProfile, ProfileDescriptor> = {
  'store-safe': {
    id: 'store-safe',
    label: 'Store Safe',
    description: 'Minimum permissions. DOM scan on request only. Context menu capture. Suitable for extension store distribution.',
    privacyNote: 'No host permissions. No network observation. No downloads API.',
    requiredPermissions: ['storage', 'activeTab', 'contextMenus'],
    optionalPermissions: [],
    optionalOrigins: [],
  },
  'smart': {
    id: 'smart',
    label: 'Smart',
    description: 'Requests optional permissions when a feature is needed. Deeper page scan on user interaction.',
    privacyNote: 'Downloads and network permissions are optional and requested on demand.',
    requiredPermissions: ['storage', 'activeTab', 'tabs', 'contextMenus', 'scripting'],
    optionalPermissions: ['downloads', 'webRequest', 'nativeMessaging'],
    optionalOrigins: [NOVA_LOOPBACK_ORIGIN_PATTERN],
  },
  'aggressive': {
    id: 'aggressive',
    label: 'Aggressive',
    description: 'All-sites access for deep capture. All optional permissions enabled after user grant.',
    privacyNote: 'Requires <all_urls> approval. No cookies forwarded.',
    requiredPermissions: ['storage', 'activeTab', 'tabs', 'contextMenus', 'scripting'],
    optionalPermissions: ['downloads', 'webRequest', 'nativeMessaging'],
    optionalOrigins: ['<all_urls>'],
  },
  'power-user': {
    id: 'power-user',
    label: 'Power User',
    description: 'Sideload/dev build. Deep capture by default. Site recipes enabled. Privacy warnings shown.',
    privacyNote: 'Intended for developer or advanced user sideloading only. All features active.',
    requiredPermissions: ['storage', 'activeTab', 'tabs', 'contextMenus', 'scripting', 'downloads', 'webRequest', 'nativeMessaging'],
    optionalPermissions: [],
    optionalOrigins: ['<all_urls>'],
  },
  'enterprise': {
    id: 'enterprise',
    label: 'Enterprise',
    description: 'Custom enterprise deployment. Configurable via managed storage policy.',
    privacyNote: 'Policy-controlled. Consult your IT administrator for details.',
    requiredPermissions: ['storage', 'activeTab', 'tabs', 'contextMenus', 'scripting'],
    optionalPermissions: ['downloads', 'webRequest', 'nativeMessaging'],
    optionalOrigins: ['<all_urls>'],
  },
};

/**
 * Apply the settings overrides corresponding to a capture profile.
 * Does not mutate input; returns a new Settings object.
 */
export function applyProfile(settings: Settings, profile: CaptureProfile): Settings {
  switch (profile) {
    case 'store-safe':
      return {
        ...settings,
        captureProfile: profile,
        capture: {
          ...settings.capture,
          aggressiveMode: false,
          network: false,
          downloads: false,
          takeoverEnabled: false,
          showLowConfidence: false,
          minFileSizeMB: 1,
        },
      };
    case 'smart':
      return {
        ...settings,
        captureProfile: profile,
        capture: {
          ...settings.capture,
          aggressiveMode: false,
          showLowConfidence: false,
        },
      };
    case 'aggressive':
      return {
        ...settings,
        captureProfile: profile,
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
    case 'power-user':
      return {
        ...settings,
        captureProfile: profile,
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
          takeoverEnabled: true,
          askBeforeTakeover: false,
        },
      };
    case 'enterprise':
      // Enterprise: keep existing settings; operator controls via managed storage
      return { ...settings, captureProfile: profile };
  }
}

/**
 * Return a human-readable description of why a feature is unavailable
 * in the current profile.
 */
export function degradedReason(feature: string, profile: CaptureProfile): string | undefined {
  const degradations: Partial<Record<CaptureProfile, Record<string, string>>> = {
    'store-safe': {
      'network-headers': 'Network header capture is not available in Store Safe mode. Switch to Smart or Aggressive profile.',
      'downloads-interception': 'Downloads API is not available in Store Safe mode.',
      'deep-scan': 'All-sites deep scan is not available in Store Safe mode.',
    },
    'smart': {
      'deep-scan': 'All-sites deep scan requires the Aggressive profile and <all_urls> permission grant.',
    },
  };
  return degradations[profile]?.[feature];
}
