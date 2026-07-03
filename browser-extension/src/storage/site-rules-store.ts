import browser from 'webextension-polyfill';
import { SiteRule, SiteRuleSchema } from '../rules/site-rules';
import { MAX_SITE_RULES } from '../contracts/limits';
import { assertStorageBudget } from '../security/storage-budget';

const SITE_RULES_KEY = 'adm.siteRules';
const SiteRulesArraySchema = SiteRuleSchema.array().max(MAX_SITE_RULES);

export class SiteRulesStore {
  async list(): Promise<SiteRule[]> {
    const raw = await browser.storage.local.get(SITE_RULES_KEY);
    const parsed = SiteRulesArraySchema.safeParse(raw[SITE_RULES_KEY]);
    return parsed.success ? parsed.data : [];
  }

  async setAll(rules: SiteRule[]): Promise<void> {
    const parsed = SiteRulesArraySchema.parse(rules);
    assertStorageBudget('site-rules-import', parsed);
    await browser.storage.local.set({ [SITE_RULES_KEY]: parsed });
  }

  async upsert(rule: SiteRule): Promise<SiteRule> {
    const parsed = SiteRuleSchema.parse(rule);
    const rules = await this.list();
    const index = rules.findIndex((item) => item.id === parsed.id);
    const next = index >= 0 ? rules.map((item) => (item.id === parsed.id ? parsed : item)) : [...rules, parsed];
    await this.setAll(next);
    return parsed;
  }

  async remove(id: string): Promise<void> {
    const rules = await this.list();
    await this.setAll(rules.filter((rule) => rule.id !== id));
  }

  async clear(): Promise<void> {
    await browser.storage.local.remove(SITE_RULES_KEY);
  }
}
