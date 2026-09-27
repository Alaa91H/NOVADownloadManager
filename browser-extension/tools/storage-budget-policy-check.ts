import { readText } from './checks-common';

const requiredFiles = [
  'src/security/storage-budget.ts',
  'src/storage/candidate-cache.ts',
  'src/storage/site-rules-store.ts',
  'src/background/message-router.ts',
  'src/outbox/outbox-store.ts',
  'src/contracts/limits.ts',
];

await Promise.all(requiredFiles.map((file) => readText(file)));

const [limits, cache, siteRules, router, outbox] = await Promise.all([
  readText('src/contracts/limits.ts'),
  readText('src/storage/candidate-cache.ts'),
  readText('src/storage/site-rules-store.ts'),
  readText('src/background/message-router.ts'),
  readText('src/outbox/outbox-store.ts'),
]);

for (const name of [
  'MAX_CANDIDATE_CACHE_BYTES_PER_TAB',
  'MAX_CANDIDATE_METADATA_BYTES',
  'MAX_SETTINGS_IMPORT_BYTES',
  'MAX_SITE_RULES_IMPORT_BYTES',
  'MAX_DIAGNOSTICS_EXPORT_BYTES',
]) {
  if (!limits.includes(name)) throw new Error(`Missing storage quota limit: ${name}`);
}

if (!cache.includes('fitCandidatesWithinStorageBudget')) throw new Error('Candidate cache must fit candidates within a storage byte budget.');
if (!cache.includes('MAX_CANDIDATE_CACHE_TABS')) throw new Error('Candidate cache tab index must be bounded by a named limit.');

if (!siteRules.includes("assertStorageBudget('site-rules-import'")) throw new Error('Site rules persistence must enforce the import storage budget.');

if (!router.includes("assertStorageBudget('settings-import'")) throw new Error('Settings import must enforce storage budget at the runtime boundary.');
if (!router.includes("assertStorageBudget('site-rules-import'")) throw new Error('Site-rule import must enforce storage budget at the runtime boundary.');
if (!router.includes('maxCandidateCacheBytesPerTab')) throw new Error('Diagnostics must expose local storage budget limits.');

if (!outbox.includes('ensureCapacityForNewJob')) throw new Error('Outbox must check capacity before accepting a new job.');
if (!outbox.includes('addIfAbsent')) throw new Error('Outbox must use atomic idempotency-aware insertion.');
if (!outbox.includes("code: 'OUTBOX_FAILED'")) throw new Error('Outbox full failures must use OUTBOX_FAILED.');

console.log('Storage budget policy guard passed.');
