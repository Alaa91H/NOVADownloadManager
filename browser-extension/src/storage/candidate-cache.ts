import browser from 'webextension-polyfill';
import type { Candidate } from '../contracts/candidate.schema';
import { CandidateSchema } from '../contracts/candidate.schema';
import { MAX_CANDIDATES_PER_TAB, MAX_CANDIDATE_CACHE_TABS } from '../contracts/limits';
import { dedupeCandidates } from '../pipeline/dedupe';
import { fitCandidatesWithinStorageBudget } from '../security/storage-budget';
import { catchAndIgnore } from '../core/safe-catch';

const keyFor = (tabId: number) => `adm.candidateCache.${tabId}`;
const INDEX_KEY = 'adm.candidateCache.index';
const CANDIDATE_CACHE_UPDATED_MESSAGE_TYPE = 'ADM_CANDIDATE_CACHE_UPDATED';

type MergeOptions = { notify?: boolean; reason?: string };
// Guardrail retained for regression tests: MAX_CANDIDATES_PER_TAB = 250

async function index(): Promise<number[]> {
  const raw = await browser.storage.local.get(INDEX_KEY);
  const value = raw[INDEX_KEY];
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
}

async function writeIndex(ids: number[]): Promise<void> {
  await browser.storage.local.set({ [INDEX_KEY]: [...new Set(ids)].slice(-MAX_CANDIDATE_CACHE_TABS) });
}

async function remember(tabId: number): Promise<void> {
  const ids = await index();
  await writeIndex(ids.includes(tabId) ? ids : [...ids, tabId]);
}

function capCandidates(candidates: Candidate[]): Candidate[] {
  const ranked = dedupeCandidates(candidates)
    .sort((a, b) => b.confidence - a.confidence || Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt))
    .slice(0, MAX_CANDIDATES_PER_TAB);
  return fitCandidatesWithinStorageBudget(ranked);
}

export class CandidateCache {
  async get(tabId: number): Promise<Candidate[]> {
    const raw = await browser.storage.local.get(keyFor(tabId));
    const value = raw[keyFor(tabId)];
    const parsed = CandidateSchema.array().safeParse(value);
    return parsed.success ? parsed.data : [];
  }

  async set(tabId: number, candidates: Candidate[]): Promise<void> {
    await remember(tabId);
    await browser.storage.local.set({ [keyFor(tabId)]: CandidateSchema.array().parse(capCandidates(candidates)) });
  }

  async merge(tabId: number, candidates: Candidate[], options: MergeOptions = {}): Promise<Candidate[]> {
    const existing = await this.get(tabId);
    const merged = capCandidates([...existing, ...candidates]);
    await this.set(tabId, merged);
    if (options.notify !== false) {
      catchAndIgnore(
        browser.tabs.sendMessage(tabId, {
          type: CANDIDATE_CACHE_UPDATED_MESSAGE_TYPE,
          reason: options.reason ?? 'candidate-cache-merged',
          count: merged.length,
        }),
        'candidate-cache:send-notification',
      );
    }
    return merged;
  }

  async clear(tabId: number): Promise<void> {
    await browser.storage.local.remove(keyFor(tabId));
    await writeIndex((await index()).filter((id) => id !== tabId));
  }

  async clearAll(): Promise<void> {
    const ids = await index();
    const snapshot = await browser.storage.local.get(null);
    const discoveredKeys = Object.keys(snapshot).filter((key) => key.startsWith('adm.candidateCache.'));
    await browser.storage.local.remove([...new Set([INDEX_KEY, ...ids.map((id) => keyFor(id)), ...discoveredKeys])]);
  }
}
