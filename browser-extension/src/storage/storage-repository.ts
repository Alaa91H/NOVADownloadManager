import browser from 'webextension-polyfill';
import { z } from 'zod';
import type { StorageBudgetKind } from '../security/storage-budget';
import { assertStorageBudget } from '../security/storage-budget';

export class StorageRepository<T> {
  constructor(
    private readonly key: string,
    private readonly schema: z.ZodType<T>,
    private readonly options?: { budgetKind?: StorageBudgetKind; fallback?: T },
  ) {}

  async get(): Promise<T> {
    const raw = await browser.storage.local.get(this.key);
    const value = raw[this.key];
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    if (this.options?.fallback !== undefined) return this.options.fallback;
    throw parsed.error;
  }

  async set(value: T): Promise<void> {
    const parsed = this.schema.parse(value);
    if (this.options?.budgetKind) assertStorageBudget(this.options.budgetKind, parsed);
    await browser.storage.local.set({ [this.key]: parsed });
  }

  async remove(): Promise<void> {
    await browser.storage.local.remove(this.key);
  }
}
