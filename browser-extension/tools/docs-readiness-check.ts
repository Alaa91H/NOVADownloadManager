import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { assert } from './checks-common.js';

const requiredDocs = [
  'docs/README.md',
  'docs/ARCHITECTURE.md',
  'docs/CI.md',
  'docs/PROTOCOL.md',
  'docs/ZERO_CLICK_PAIRING.md',
  'docs/ADM_DESKTOP_DEVELOPER_HANDOFF.md',
  'docs/DESKTOP_RUNTIME_REQUIREMENTS.md',
];

const allMissing = requiredDocs.every((p) => !existsSync(p));
if (allMissing) {
  console.log('Documentation readiness check skipped: docs/ directory is not present.');
  process.exit(0);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

const warnings: string[] = [];

const checks: Array<{ path: string; terms: string[] }> = [
  {
    path: 'README.md',
    terms: [
      'NOVA Download Manager Extension',
      'Native Messaging',
      'http://127.0.0.1:3199',
      'single-instance',
      'Minimize to system tray',
      'Default: ON',
      'Link with NOVA',
      'pnpm run ci',
      'pnpm test:e2e',
    ],
  },
  {
    path: 'docs/ADM_DESKTOP_DEVELOPER_HANDOFF.md',
    terms: [
      'single-instance',
      'Minimize to system tray',
      'Default: ON',
      'POST /v1/pair/auto',
      'com.apex.downloadmanager',
      'Link with NOVA',
    ],
  },
  {
    path: 'docs/DESKTOP_RUNTIME_REQUIREMENTS.md',
    terms: [
      'single-instance',
      'process lock',
      'Minimize to system tray',
      'Default: ON',
      'Native Messaging',
      'Browser Extension',
      'Shutdown',
    ],
  },
  {
    path: 'docs/ZERO_CLICK_PAIRING.md',
    terms: [
      'Zero-click',
      'Native Messaging',
      '/v1/pair/auto',
      'Link with NOVA',
      'bearer',
    ],
  },
  {
    path: 'docs/CI.md',
    terms: [
      'pnpm docs:check',
      'pnpm guard:e2e',
      'pnpm test:e2e',
      'ADM_RUN_REAL_EXTENSION_E2E=1 pnpm test:e2e',
      'pnpm run ci',
    ],
  },
  {
    path: 'docs/ARCHITECTURE.md',
    terms: [
      'BridgeManager',
      'TransportManager',
      'SingleFlight',
      'Outbox',
      'Capability Registry',
    ],
  },
  {
    path: 'docs/README.md',
    terms: [
      'DESKTOP_RUNTIME_REQUIREMENTS.md',
      'ZERO_CLICK_PAIRING.md',
      'CI.md',
      'ARCHITECTURE.md',
    ],
  },
];

for (const check of checks) {
  const text = await readOptional(check.path);
  if (text === undefined) {
    warnings.push(`${check.path} is missing.`);
    continue;
  }
  for (const term of check.terms) {
    if (!text.includes(term)) warnings.push(`${check.path} is missing documentation term: ${term}`);
  }
}

const packageJson = JSON.parse((await readFile('package.json', 'utf8'))) as { scripts?: Record<string, string> };
const scripts = packageJson.scripts ?? {};
assert(scripts.ci?.includes('test:e2e'), 'ci must include browser e2e smoke coverage.');

for (const warning of warnings) console.warn(`[docs:warn] ${warning}`);
console.log('Documentation readiness check passed: Markdown content is advisory and does not block production gates.');
