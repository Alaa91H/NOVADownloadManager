import browser from 'webextension-polyfill';
import { BridgeStateSchema, initialBridgeState } from '../core/app-state';
import { defaultSettings, SettingsSchema } from '../contracts/settings.schema';
import { MAX_SITE_RULES } from '../contracts/limits';
import { SiteRuleSchema } from '../rules/site-rules';
import type { SiteRule } from '../rules/site-rules';

const SCHEMA_VERSION_KEY = 'adm.storageSchemaVersion';
const MIGRATED_AT_KEY = 'adm.storageMigratedAt';
const CANDIDATE_INDEX_KEY = 'adm.candidateCache.index';
const SITE_RULES_KEY = 'adm.siteRules';
const CURRENT_STORAGE_SCHEMA_VERSION = 3;
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

export class MigrationStore {
  async status(): Promise<{ schemaVersion: number; migratedAt?: string }> {
    const values = await browser.storage.local.get([SCHEMA_VERSION_KEY, MIGRATED_AT_KEY]);
    return {
      schemaVersion: asVersion(values[SCHEMA_VERSION_KEY]),
      migratedAt: typeof values[MIGRATED_AT_KEY] === 'string' ? values[MIGRATED_AT_KEY] : undefined,
    };
  }

  async migrate(): Promise<MigrationReport> {
    const snapshot = await browser.storage.local.get([SCHEMA_VERSION_KEY, 'adm.settings', 'adm.bridgeState', SITE_RULES_KEY, CANDIDATE_INDEX_KEY]);
    const fromVersion = asVersion(snapshot[SCHEMA_VERSION_KEY]);
    const repairedKeys: string[] = [];
    const updates: Record<string, unknown> = {};

    const settings = SettingsSchema.safeParse(snapshot['adm.settings']);
    if (!settings.success) {
      updates['adm.settings'] = SettingsSchema.catch(defaultSettings).parse(snapshot['adm.settings'] ?? {});
      repairedKeys.push('adm.settings');
    }

    const bridgeState = BridgeStateSchema.safeParse(snapshot['adm.bridgeState']);
    if (snapshot['adm.bridgeState'] !== undefined && !bridgeState.success) {
      updates['adm.bridgeState'] = initialBridgeState;
      repairedKeys.push('adm.bridgeState');
    }


    const siteRules = SiteRulesArraySchema.safeParse(snapshot[SITE_RULES_KEY]);
    if (snapshot[SITE_RULES_KEY] !== undefined && !siteRules.success) {
      const rawRules = Array.isArray(snapshot[SITE_RULES_KEY]) ? snapshot[SITE_RULES_KEY] : [];
      updates[SITE_RULES_KEY] = rawRules
        .map((rule) => SiteRuleSchema.safeParse(rule))
        .filter((result): result is { success: true; data: SiteRule } => result.success)
        .map((result) => result.data)
        .slice(0, MAX_SITE_RULES);
      repairedKeys.push(SITE_RULES_KEY);
    }

    const normalizedIndex = normalizeCandidateIndex(snapshot[CANDIDATE_INDEX_KEY]);
    if (normalizedIndex && JSON.stringify(normalizedIndex) !== JSON.stringify(snapshot[CANDIDATE_INDEX_KEY] ?? [])) {
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
