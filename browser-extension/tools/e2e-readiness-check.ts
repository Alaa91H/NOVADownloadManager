import { readFile } from 'node:fs/promises';
import { assert } from './checks-common.js';

async function read(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

const packageJson = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };
const scripts = packageJson.scripts ?? {};
const playwrightConfig = await read('playwright.config.ts');
const e2eSpec = await read('src/tests/e2e/popup.spec.ts');
const workflow = await read('../docs/extension/ci-templates/legacy-extension-ci.yml');

assert(
  scripts['test:e2e'] === 'playwright test',
  'test:e2e must execute the Playwright suite directly.',
);
assert(
  playwrightConfig.includes("testDir: 'src/tests/e2e'"),
  'Playwright config must point at src/tests/e2e.',
);
assert(
  playwrightConfig.includes("trace: 'retain-on-failure'"),
  'Playwright traces must be retained on failure.',
);
assert(
  playwrightConfig.includes("video: 'retain-on-failure'"),
  'Playwright videos must be retained on failure.',
);

for (const term of [
  'startStaticServer',
  'installExtensionApiMock',
  'getByRole',
  'RESET_PAIRING',
  'Transport',
  'Protocol',
  'NOVA_RUN_REAL_EXTENSION_E2E',
  'chromium.launchPersistentContext',
  '--disable-extensions-except=',
  '--load-extension=',
  '--disable-dev-shm-usage',
  '--no-default-browser-check',
  '--ozone-platform=x11',
  'chrome-extension://',
  'NOVA_RUN_REAL_EXTENSION_E2E',
  'NOVA_E2E_BROWSER_LAUNCH_TIMEOUT_MS',
  'NOVA_E2E_EXTENSION_REGISTRATION_TIMEOUT_MS',
  'fs.mkdtempSync',
  'readExtensionIdFromPreferences',
  'waitForExtensionIdFromPreferences',
  'context.waitForEvent',
]) {
  assert(e2eSpec.includes(term), `E2E popup smoke test is missing ${term}.`);
}

for (const term of [
  'browser-e2e',
  "install-playwright: 'true'",
  'Download unpacked browser builds',
  'actions/download-artifact@v8.0.1',
  'nova-browser-extension-unpacked',
  'EXTENSION_UNPACKED_DIR: dist/chromium',
  'Run Playwright smoke tests against the existing Chromium build',
  'run: pnpm test:e2e',
  'actions/upload-artifact@v7.0.1',
]) {
  assert(workflow.includes(term), `CI browser E2E job is missing ${term}.`);
}

const legacyChromiumRebuildCommand = [
  'node scripts/run-python.js',
  'build.py',
  '--clean',
  '--target chromium',
].join(' ');

assert(
  !workflow.includes(legacyChromiumRebuildCommand),
  'CI browser E2E job must reuse package-build artifacts instead of rebuilding Chromium.',
);

console.log(
  'E2E readiness check passed: popup Playwright smoke coverage is wired to source, package scripts, and CI.',
);
