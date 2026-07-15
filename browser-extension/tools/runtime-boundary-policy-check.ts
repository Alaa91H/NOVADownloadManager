import { readFile } from 'node:fs/promises';
import { assert } from './checks-common.js';

const router = await readFile('src/background/message-router.ts', 'utf8');
const messages = await readFile('src/contracts/messages.schema.ts', 'utf8');
const scanPolicy = await readFile('src/security/page-scan-policy.ts', 'utf8');
const wxt = await readFile('wxt.config.ts', 'utf8');
const manifest = await readFile('src/manifest.json', 'utf8');
const contentScanner = await readFile('src/content/scanner.ts', 'utf8');
const tabScanner = await readFile('src/background/tab-scanner.ts', 'utf8');

const budgetIndex = router.indexOf('assertRuntimeMessageBudget(raw)');
const parseIndex = router.indexOf('RuntimeMessageSchema.safeParse(raw)');
assert(budgetIndex >= 0, 'Runtime message router must enforce a size budget before schema validation.');
assert(parseIndex >= 0, 'Runtime message router must validate messages with RuntimeMessageSchema.');
assert(budgetIndex < parseIndex, 'Runtime message budget must run before RuntimeMessageSchema.safeParse(raw).');

assert(messages.includes("type: z.literal('IMPORT_SETTINGS'), settings: z.unknown()"), 'Settings import must remain unknown at runtime boundary so size is checked before parsing.');
assert(messages.includes("type: z.literal('IMPORT_SITE_RULES'), rules: z.unknown()"), 'Site-rules import must remain unknown at runtime boundary so size is checked before parsing.');
assert(router.includes("assertStorageBudget('settings-import', settings)"), 'Settings import must enforce storage budget before SettingsSchema.parse.');
assert(router.includes("assertStorageBudget('site-rules-import', msg.rules)"), 'Site-rules import must enforce storage budget before SiteRulesImportSchema.parse.');

assert(scanPolicy.includes('TRUSTED_EXTENSION_UI_PATHS'), 'Scan policy must declare trusted UI paths.');
assert(scanPolicy.includes("'/popup.html'"), 'Scan policy must pin exact extension UI pages.');
assert(!scanPolicy.includes('pathname.includes(surface)'), 'Trusted UI sender matching must not be substring-based.');

for (const source of [wxt, manifest]) {
  assert(!source.includes('127.0.0.1:*'), 'Loopback CSP must not allow wildcard ports.');
  assert(!source.includes('localhost:*'), 'Loopback CSP must not allow wildcard localhost ports.');
  assert(source.includes('http://127.0.0.1:3199') && source.includes('ws://127.0.0.1:3199'), 'Loopback CSP must pin NOVA HTTP and WebSocket port 3199.');
}

assert(!contentScanner.includes('drmIndicators:'), 'Content scanner must not collect DRM indicators by default.');
assert(!tabScanner.includes('collectDrmIndicators'), 'Tab scanner must not call DRM collection by default.');

console.log('Runtime boundary policy passed: messages are budgeted, scan trust is exact, CSP is pinned, and DRM guard remains inactive.');
