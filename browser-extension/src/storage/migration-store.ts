import browser from 'webextension-polyfill';
import { BridgeStateSchema, initialBridgeState } from '../core/app-state';
import { defaultSettings, SettingsSchema } from '../contracts/settings.schema';
import { legacyPascalProductToken, legacyStoragePrefix } from '../core/legacy-names';
import { MAX_SITE_RULES } from '../contracts/limits';
import { SiteRuleSchema } from '../rules/site-rules';
import type { SiteRule } from '../rules/site-rules';

const SCHEMA_VERSION_KEY = 'nova.storageSchemaVersion';
const MIGRATED_AT_KEY = 'nova.storageMigratedAt';
const CANDIDATE_INDEX_KEY = 'nova.candidateCache.index';
const SITE_RULES_KEY = 'nova.siteRules';
const SETTINGS_KEY = 'nova.settings';
const BRIDGE_STATE_KEY = 'nova.bridgeState';
const TOKEN_KEY = 'nova.pairToken';
const OVERLAY_POSITION_KEY = 'nova.videoOverlayPosition.v1';
const DIAGNOSTICS_KEY = 'nova.diagnostics';
const CURRENT_STORAGE_SCHEMA_VERSION = 5;
const SiteRulesArraySchema = SiteRuleSchema.array().max(MAX_SITE_RULES);
const legacyKey = (suffix: string): string => `${legacyStoragePrefix()}.${suffix}`;
const LEGACY_SETTINGS_KEY = legacyKey('settings');
const LEGACY_BRIDGE_STATE_KEY = legacyKey('bridgeState');
const LEGACY_SCHEMA_VERSION_KEY = legacyKey('storageSchemaVersion');
const LEGACY_MIGRATED_AT_KEY = legacyKey('storageMigratedAt');
const LEGACY_CANDIDATE_INDEX_KEY = legacyKey('candidateCache.index');
const LEGACY_CANDIDATE_CACHE_PREFIX = legacyKey('candidateCache.');
const LEGACY_SITE_RULES_KEY = legacyKey('siteRules');
const LEGACY_TOKEN_KEY = legacyKey('pairToken');
const LEGACY_OVERLAY_POSITION_KEY = legacyKey('videoOverlayPosition.v1');
const LEGACY_DIAGNOSTICS_KEY = legacyKey('diagnostics');
const legacyOpenAfterSendKey = (): string => `open${legacyPascalProductToken()}AfterSend`;

export type MigrationReport = {
  fromVersion: number;
  toVersion: number;
  repairedKeys: string[];
  migratedAt: string;
};

function asVersion(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeCandidateIndex(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((item): item is number => Number.isInteger(item) && item > 0);
  return [...new Set(ids)].slice(-100);
}

function migrateSettingsShape(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const openAfterSendKey = legacyOpenAfterSendKey();
  if (next.openNovaAfterSend === undefined && next[openAfterSendKey] !== undefined) {
    next.openNovaAfterSend = next[openAfterSendKey];
  }
  delete next[openAfterSendKey];
  return next;
}

/**
 * Schema v5: force absolute download takeover so the browser never keeps files.
 * Existing installs may still have takeoverEnabled=false / aggressiveMode=false.
 */
function forceAbsoluteDownloadTakeover(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const captureRaw = next.capture;
  const capture: Record<string, unknown> =
    captureRaw && typeof captureRaw === 'object' && !Array.isArray(captureRaw)
      ? { ...(captureRaw as Record<string, unknown>) }
      : {};

  next.captureProfile = 'aggressive';
  capture.aggressiveMode = true;
  capture.downloads = true;
  capture.network = true;
  capture.takeoverEnabled = true;
  capture.askBeforeTakeover = false;
  capture.takeoverMinSizeMB = 0;
  capture.takeoverFileTypes = [];
  capture.minFileSizeMB = 0;
  capture.showLowConfidence = true;
  next.capture = capture;
  return next;
}

function preferNew(snapshot: Record<string, unknown>, nextKey: string, legacyKeyName: string): unknown {
  return snapshot[nextKey] !== undefined ? snapshot[nextKey] : snapshot[legacyKeyName];
}

function stageLegacyCopy(
  snapshot: Record<string, unknown>,
  updates: Record<string, unknown>,
  removeKeys: string[],
  repairedKeys: string[],
  nextKey: string,
  legacyKeyName: string,
  transform: (value: unknown) => unknown = (value) => value,
): void {
  if (snapshot[nextKey] === undefined && snapshot[legacyKeyName] !== undefined) {
    updates[nextKey] = transform(snapshot[legacyKeyName]);
    repairedKeys.push(`${legacyKeyName}->${nextKey}`);
  }
  if (snapshot[legacyKeyName] !== undefined) removeKeys.push(legacyKeyName);
}

export class MigrationStore {
  async status(): Promise<{ schemaVersion: number; migratedAt?: string }> {
    const values = await browser.storage.local.get([SCHEMA_VERSION_KEY, MIGRATED_AT_KEY, LEGACY_SCHEMA_VERSION_KEY, LEGACY_MIGRATED_AT_KEY]);
    return {
      schemaVersion: asVersion(values[SCHEMA_VERSION_KEY] ?? values[LEGACY_SCHEMA_VERSION_KEY]),
      migratedAt: typeof values[MIGRATED_AT_KEY] === 'string'
        ? values[MIGRATED_AT_KEY]
        : typeof values[LEGACY_MIGRATED_AT_KEY] === 'string'
          ? values[LEGACY_MIGRATED_AT_KEY]
          : undefined,
    };
  }

  async migrate(): Promise<MigrationReport> {
    const snapshot = await browser.storage.local.get(null);
    const fromVersion = asVersion(snapshot[SCHEMA_VERSION_KEY] ?? snapshot[LEGACY_SCHEMA_VERSION_KEY]);
    const repairedKeys: string[] = [];
    const updates: Record<string, unknown> = {};
    const removeKeys: string[] = [];

    stageLegacyCopy(snapshot, updates, removeKeys, repairedKeys, SETTINGS_KEY, LEGACY_SETTINGS_KEY, migrateSettingsShape);
    stageLegacyCopy(snapshot, updates, removeKeys, repairedKeys, BRIDGE_STATE_KEY, LEGACY_BRIDGE_STATE_KEY);
    stageLegacyCopy(snapshot, updates, removeKeys, repairedKeys, SITE_RULES_KEY, LEGACY_SITE_RULES_KEY);
    stageLegacyCopy(snapshot, updates, removeKeys, repairedKeys, CANDIDATE_INDEX_KEY, LEGACY_CANDIDATE_INDEX_KEY);
    stageLegacyCopy(snapshot, updates, removeKeys, repairedKeys, TOKEN_KEY, LEGACY_TOKEN_KEY);
    stageLegacyCopy(snapshot, updates, removeKeys, repairedKeys, OVERLAY_POSITION_KEY, LEGACY_OVERLAY_POSITION_KEY);
    stageLegacyCopy(snapshot, updates, removeKeys, repairedKeys, DIAGNOSTICS_KEY, LEGACY_DIAGNOSTICS_KEY);
    if (snapshot[LEGACY_SCHEMA_VERSION_KEY] !== undefined) removeKeys.push(LEGACY_SCHEMA_VERSION_KEY);
    if (snapshot[LEGACY_MIGRATED_AT_KEY] !== undefined) removeKeys.push(LEGACY_MIGRATED_AT_KEY);

    for (const [key, value] of Object.entries(snapshot)) {
      if (key.startsWith(LEGACY_CANDIDATE_CACHE_PREFIX)) {
        const nextKey = `nova.candidateCache.${key.slice(LEGACY_CANDIDATE_CACHE_PREFIX.length)}`;
        if (snapshot[nextKey] === undefined) updates[nextKey] = value;
        removeKeys.push(key);
      }
    }

    const settingsValue = updates[SETTINGS_KEY] ?? preferNew(snapshot, SETTINGS_KEY, LEGACY_SETTINGS_KEY);
    const needsAbsoluteTakeoverMigration = fromVersion < 5;
    const migratedShape = migrateSettingsShape(settingsValue ?? (needsAbsoluteTakeoverMigration ? {} : undefined));
    const shapedSettings = needsAbsoluteTakeoverMigration
      ? forceAbsoluteDownloadTakeover(migratedShape ?? {})
      : migratedShape;
    const settings = SettingsSchema.safeParse(shapedSettings);
    if (!settings.success) {
      updates[SETTINGS_KEY] = SettingsSchema.catch(defaultSettings).parse(shapedSettings ?? {});
      repairedKeys.push(SETTINGS_KEY);
    } else if (settingsValue !== undefined || needsAbsoluteTakeoverMigration) {
      updates[SETTINGS_KEY] = settings.data;
      if (needsAbsoluteTakeoverMigration) repairedKeys.push(`${SETTINGS_KEY}:absolute-takeover-v5`);
    }

    const bridgeStateValue = updates[BRIDGE_STATE_KEY] ?? preferNew(snapshot, BRIDGE_STATE_KEY, LEGACY_BRIDGE_STATE_KEY);
    const bridgeState = BridgeStateSchema.safeParse(bridgeStateValue);
    if (bridgeStateValue !== undefined && !bridgeState.success) {
      updates[BRIDGE_STATE_KEY] = initialBridgeState;
      repairedKeys.push(BRIDGE_STATE_KEY);
    }


    const siteRulesValue = updates[SITE_RULES_KEY] ?? preferNew(snapshot, SITE_RULES_KEY, LEGACY_SITE_RULES_KEY);
    const siteRules = SiteRulesArraySchema.safeParse(siteRulesValue);
    if (siteRulesValue !== undefined && !siteRules.success) {
      const rawRules = Array.isArray(siteRulesValue) ? siteRulesValue : [];
      updates[SITE_RULES_KEY] = rawRules
        .map((rule) => SiteRuleSchema.safeParse(rule))
        .filter((result): result is { success: true; data: SiteRule } => result.success)
        .map((result) => result.data)
        .slice(0, MAX_SITE_RULES);
      repairedKeys.push(SITE_RULES_KEY);
    }

    const candidateIndexValue = updates[CANDIDATE_INDEX_KEY] ?? preferNew(snapshot, CANDIDATE_INDEX_KEY, LEGACY_CANDIDATE_INDEX_KEY);
    const normalizedIndex = normalizeCandidateIndex(candidateIndexValue);
    if (normalizedIndex && JSON.stringify(normalizedIndex) !== JSON.stringify(candidateIndexValue ?? [])) {
      updates[CANDIDATE_INDEX_KEY] = normalizedIndex;
      repairedKeys.push(CANDIDATE_INDEX_KEY);
    }

    const migratedAt = new Date().toISOString();
    updates[SCHEMA_VERSION_KEY] = CURRENT_STORAGE_SCHEMA_VERSION;
    updates[MIGRATED_AT_KEY] = migratedAt;
    await browser.storage.local.set(updates);
    if (removeKeys.length > 0) await browser.storage.local.remove([...new Set(removeKeys)]);

    return { fromVersion, toVersion: CURRENT_STORAGE_SCHEMA_VERSION, repairedKeys, migratedAt };
  }
}
