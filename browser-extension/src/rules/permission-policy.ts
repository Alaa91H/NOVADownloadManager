import browser from 'webextension-polyfill';
import { validatePermissionRequest, ADM_LOOPBACK_ORIGIN_PATTERN } from '../security/permission-request-policy';

// Re-exported for backward compatibility with existing importers.
export { ADM_LOOPBACK_ORIGIN_PATTERN };

export type DegradedFeature = 'downloads-interception' | 'deep-scan' | 'network-headers' | 'native-messaging' | 'tab-scripting';

export type PermissionNeed = {
  permissions?: string[];
  origins?: string[];
};

export type PermissionStatusEntry = {
  granted: boolean;
  reason: string;
  degradedFeature?: DegradedFeature;
};

const permissionCatalog: Record<string, PermissionNeed & { reason: string; degradedFeature?: DegradedFeature }> = {
  storage: { permissions: ['storage'], reason: 'Persist settings, pairing state, outbox jobs, and local candidate cache.' },
  downloads: { permissions: ['downloads'], reason: 'Observe browser-created downloads and hand off only after ADM accepts the task.', degradedFeature: 'downloads-interception' },
  webRequest: { permissions: ['webRequest'], origins: ['<all_urls>'], reason: 'Read safe response headers for active-tab download metadata.', degradedFeature: 'network-headers' },
  scripting: { permissions: ['scripting'], reason: 'Run explicit user-activated page scans without broad permanent host access.', degradedFeature: 'tab-scripting' },
  activeTab: { permissions: ['activeTab'], reason: 'Temporarily access the current tab only after the user invokes the extension.', degradedFeature: 'tab-scripting' },
  tabs: { permissions: ['tabs'], reason: 'Resolve active tab id and page URL for popup-driven capture.', degradedFeature: 'tab-scripting' },
  allUrls: { origins: ['<all_urls>'], reason: 'Enable deep capture across arbitrary sites when the user opts in.', degradedFeature: 'deep-scan' },
  loopback: { origins: [ADM_LOOPBACK_ORIGIN_PATTERN], reason: 'Talk only to the local ADM daemon on loopback.' },
  nativeMessaging: { permissions: ['nativeMessaging'], reason: 'Wake and verify the ADM Native Messaging host.', degradedFeature: 'native-messaging' },
};

export class PermissionPolicy {
  async has(permissions: string[] = [], origins: string[] = []): Promise<boolean> {
    return browser.permissions.contains({ permissions: permissions as never[], origins: origins as never[] });
  }

  async request(permissions: string[] = [], origins: string[] = []): Promise<{ granted: boolean; degraded: DegradedFeature[]; requested: { permissions: string[]; origins: string[] } }> {
    const requested = validatePermissionRequest(permissions, origins);
    const granted = await browser.permissions.request({ permissions: requested.permissions as never[], origins: requested.origins as never[] });
    return { granted, requested, degraded: granted ? [] : this.degraded([...requested.permissions, ...requested.origins]) };
  }

  degraded(missing: string[]): DegradedFeature[] {
    return [...new Set(missing.map((m) => {
      if (m === 'downloads') return 'downloads-interception';
      if (m === 'webRequest') return 'network-headers';
      if (m === 'scripting' || m === 'tabs' || m === 'activeTab') return 'tab-scripting';
      if (m === '<all_urls>' || m === '*://*/*') return 'deep-scan';
      return 'native-messaging';
    }))];
  }

  explain(key: keyof typeof permissionCatalog): string {
    const entry = permissionCatalog[key];
    return entry?.reason ?? 'Permission is required for this feature.';
  }

  async status(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(Object.entries(permissionCatalog).map(async ([key, query]) => [key, await browser.permissions.contains({ permissions: (query.permissions ?? []) as never[], origins: (query.origins ?? []) as never[] })] as const));
    return Object.fromEntries(entries);
  }

  async detailedStatus(): Promise<Record<string, PermissionStatusEntry>> {
    const entries = await Promise.all(Object.entries(permissionCatalog).map(async ([key, query]) => [key, {
      granted: await browser.permissions.contains({ permissions: (query.permissions ?? []) as never[], origins: (query.origins ?? []) as never[] }),
      reason: query.reason,
      degradedFeature: query.degradedFeature,
    }] as const));
    return Object.fromEntries(entries);
  }

  async diagnostics<T extends Record<string, unknown>>(base: T): Promise<T & { permissions: Record<string, PermissionStatusEntry> }> {
    return { ...base, permissions: await this.detailedStatus() };
  }
}
