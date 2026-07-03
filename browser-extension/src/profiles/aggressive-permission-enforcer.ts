import browser from 'webextension-polyfill';
import { Logger } from '../core/logger';
import { PermissionPolicy } from '../rules/permission-policy';
import { SettingsStore } from '../storage/settings-store';
import { AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE, disableAggressiveCapture } from './aggressive-capture-profile';

const log = new Logger('aggressive-permission-enforcer');
const settingsStore = new SettingsStore();
const permissionPolicy = new PermissionPolicy();
let watcherRegistered = false;

export type AggressivePermissionIntegrity = {
  enabled: boolean;
  valid: boolean;
  enforced: boolean;
  missingPermissions: string[];
  missingOrigins: string[];
  checkedAt: string;
};

async function missingPermissions(): Promise<Pick<AggressivePermissionIntegrity, 'missingPermissions' | 'missingOrigins'>> {
  const missingPerms: string[] = [];
  const missingOrigins: string[] = [];

  for (const permission of AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions) {
    const granted = await permissionPolicy.has([permission], []);
    if (!granted) missingPerms.push(permission);
  }

  for (const origin of AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins) {
    const granted = await permissionPolicy.has([], [origin]);
    if (!granted) missingOrigins.push(origin);
  }

  return { missingPermissions: missingPerms, missingOrigins };
}

export async function getAggressivePermissionIntegrity(): Promise<AggressivePermissionIntegrity> {
  const settings = await settingsStore.get();
  const missing = await missingPermissions();
  return {
    enabled: settings.capture.aggressiveMode,
    valid: !settings.capture.aggressiveMode || (missing.missingPermissions.length === 0 && missing.missingOrigins.length === 0),
    enforced: true,
    ...missing,
    checkedAt: new Date().toISOString(),
  };
}

export async function enforceAggressivePermissions(reason: string): Promise<AggressivePermissionIntegrity> {
  const settings = await settingsStore.get();
  const missing = await missingPermissions();
  const valid = missing.missingPermissions.length === 0 && missing.missingOrigins.length === 0;

  if (settings.capture.aggressiveMode && !valid) {
    await settingsStore.set(disableAggressiveCapture(settings));
    log.warn('Aggressive Capture Mode disabled because required permissions are no longer granted.', {
      reason,
      missingPermissions: missing.missingPermissions,
      missingOrigins: missing.missingOrigins,
    });
    return {
      enabled: false,
      valid: false,
      enforced: true,
      ...missing,
      checkedAt: new Date().toISOString(),
    };
  }

  return {
    enabled: settings.capture.aggressiveMode,
    valid: !settings.capture.aggressiveMode || valid,
    enforced: true,
    ...missing,
    checkedAt: new Date().toISOString(),
  };
}

function permissionRemovalTouchesAggressiveBundle(removed: { permissions?: string[]; origins?: string[] }): boolean {
  const removedPermissions = new Set(removed.permissions ?? []);
  const removedOrigins = new Set(removed.origins ?? []);
  return AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions.some((permission) => removedPermissions.has(permission))
    || AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins.some((origin) => removedOrigins.has(origin));
}

export function registerAggressivePermissionRevocationWatcher(): void {
  if (watcherRegistered) return;
  watcherRegistered = true;
  browser.permissions.onRemoved.addListener((removed) => {
    if (!permissionRemovalTouchesAggressiveBundle(removed)) return;
    void enforceAggressivePermissions('permissions.onRemoved').catch((error) => log.error('Aggressive permission enforcement failed.', error));
  });
}
