import browser from 'webextension-polyfill';
import { z } from 'zod';

const TOKEN_KEY = 'nova.pairToken';
const TOKEN_RECORD_VERSION = 1;

const TokenRecordSchema = z.object({
  version: z.literal(TOKEN_RECORD_VERSION),
  token: z.string().min(24),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
});

type TokenRecord = z.infer<typeof TokenRecordSchema>;

function isExpired(record: TokenRecord, now = new Date()): boolean {
  return Boolean(record.expiresAt && record.expiresAt <= now.toISOString());
}

function expiresAt(ttlSeconds?: number): string | undefined {
  if (ttlSeconds === undefined || ttlSeconds === null || !Number.isFinite(ttlSeconds)) return undefined;
  if (ttlSeconds <= 0) return new Date(0).toISOString();
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

export type TokenStatus = {
  present: boolean;
  expired: boolean;
  createdAt?: string;
  expiresAt?: string;
  storageFormat: 'none' | 'legacy-string' | 'record' | 'invalid';
};

export class TokenStore {
  async get(): Promise<string | undefined> {
    const values = await browser.storage.local.get(TOKEN_KEY);
    const value = values[TOKEN_KEY];

    if (typeof value === 'string') {
      if (value.length < 24) {
        await this.clear();
        return undefined;
      }
      return value;
    }

    const parsed = TokenRecordSchema.safeParse(value);
    if (!parsed.success) {
      if (value !== undefined) await this.clear();
      return undefined;
    }

    if (isExpired(parsed.data)) {
      await this.clear();
      return undefined;
    }

    return parsed.data.token;
  }

  async set(token: string, ttlSeconds?: number): Promise<void> {
    const record = TokenRecordSchema.parse({
      version: TOKEN_RECORD_VERSION,
      token,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt(ttlSeconds),
    });
    await browser.storage.local.set({ [TOKEN_KEY]: record });
  }

  async status(): Promise<TokenStatus> {
    const values = await browser.storage.local.get(TOKEN_KEY);
    const value = values[TOKEN_KEY];
    if (value === undefined) return { present: false, expired: false, storageFormat: 'none' };
    if (typeof value === 'string') return { present: value.length >= 24, expired: false, storageFormat: 'legacy-string' };
    const parsed = TokenRecordSchema.safeParse(value);
    if (!parsed.success) return { present: false, expired: false, storageFormat: 'invalid' };
    return {
      present: true,
      expired: isExpired(parsed.data),
      createdAt: parsed.data.createdAt,
      expiresAt: parsed.data.expiresAt,
      storageFormat: 'record',
    };
  }

  async clear(): Promise<void> {
    await browser.storage.local.remove(TOKEN_KEY);
  }
}
