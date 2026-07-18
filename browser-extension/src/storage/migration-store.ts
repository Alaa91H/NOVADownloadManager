import browser from 'webextension-polyfill';
import { BridgeStateSchema, initialBridgeState } from '../core/app-state';
import { defaultSettings, SettingsSchema } from '../contracts/settings.schema';
import { MAX_SITE_RULES } from '../contracts/limits';
import { SiteRuleSchema } from '../rules/site-rules';
import type { SiteRule } from '../rules/site-rules';

const SCHEMA_VERSION_KEY = 'nova.storageSchemaVersion';
const MIGRATED_AT_KEY = 'nova.storageMigratedAt';
const CANDIDATE_INDEX_KEY = 'nova.candidateCache.index';
const SITE_RULES_KEY = 'nova.siteRules';
const SETTINGS_KEY = 'nova.settings';
const BRIDGE_STATE_KEY = 'nova.bridgeState';
const CURRENT_STORAGE_SCHEMA_VERSION = 5;
const SiteRulesArraySchema = SiteRuleSchema.array().max(MAX_SITE_RULES);

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

export class MigrationStore {
  async status(): Promise<{ schemaVersion: number; migratedAt?: string }> {
    const values = await browser.storage.local.get([SCHEMA_VERSION_KEY, MIGRATED_AT_KEY]);
    return {
      schemaVersion: asVersion(values[SCHEMA_VERSION_KEY]),
      migratedAt: typeof values[MIGRATED_AT_KEY] === 'string' ? values[MIGRATED_AT_KEY] : undefined,
    };
  }

  async migrate(): Promise<MigrationReport> {
    const snapshot = await browser.storage.local.get(null);
    const fromVersion = asVersion(snapshot[SCHEMA_VERSION_KEY]);
    const repairedKeys: string[] = [];
    const updates: Record<string, unknown> = {};

    const needsAbsoluteTakeoverMigration = fromVersion < 5;
    const settingsValue = snapshot[SETTINGS_KEY];
    const shapedSettings = needsAbsoluteTakeoverMigration
      ? forceAbsoluteDownloadTakeover(settingsValue ?? {})
      : settingsValue;
    const settings = SettingsSchema.safeParse(shapedSettings);
    if (!settings.success) {
      updates[SETTINGS_KEY] = SettingsSchema.catch(defaultSettings).parse(shapedSettings ?? {});
      repairedKeys.push(SETTINGS_KEY);
    } else if (settingsValue !== undefined || needsAbsoluteTakeoverMigration) {
      updates[SETTINGS_KEY] = settings.data;
      if (needsAbsoluteTakeoverMigration) repairedKeys.push(`${SETTINGS_KEY}:absolute-takeover-v5`);
    }

    const bridgeStateValue = snapshot[BRIDGE_STATE_KEY];
    const bridgeState = BridgeStateSchema.safeParse(bridgeStateValue);
    if (bridgeStateValue !== undefined && !bridgeState.success) {
      updates[BRIDGE_STATE_KEY] = initialBridgeState;
      repairedKeys.push(BRIDGE_STATE_KEY);
    }

    const siteRulesValue = snapshot[SITE_RULES_KEY];
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

    const candidateIndexValue = snapshot[CANDIDATE_INDEX_KEY];
    const normalizedIndex = normalizeCandidateIndex(candidateIndexValue);
    if (normalizedIndex && JSON.stringify(normalizedIndex) !== JSON.stringify(candidateIndexValue ?? [])) {
      updates[CANDIDATE_INDEX_KEY] = normalizedIndex;
      repairedKeys.push(CANDIDATE_INDEX_KEY);
    }

    const migratedAt = new Date().toISOString();
    updates[SCHEMA_VERSION_KEY] = CURRENT_STORAGE_SCHEMA_VERSION;
    updates[MIGRATED_AT_KEY] = migratedAt;
    await browser.storage.local.set(updates);

    return { fromVersion, toVersion: CURRENT_STORAGE_SCHEMA_VERSION, repairedKeys, migratedAt };
  }
}
