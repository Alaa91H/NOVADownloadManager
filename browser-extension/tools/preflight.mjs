#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function fail(message) {
  console.error(`preflight failed: ${message}`);
  process.exit(1);
}

function parseMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version).trim());
  return match ? Number(match[1]) : Number.NaN;
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const nodeMajor = parseMajor(process.version);
if (!Number.isFinite(nodeMajor) || nodeMajor < 24 || nodeMajor >= 27) {
  fail(`Node ${process.version} is unsupported. Use Node >=24 <27 as declared in package.json engines.`);
}

const nvmrc = readFileSync('.nvmrc', 'utf8').trim();
if (nvmrc !== '24') fail(`.nvmrc must pin Node 24, found ${nvmrc || '<empty>'}.`);
if (pkg.packageManager !== 'pnpm@11.6.0') fail(`packageManager must stay pnpm@11.6.0, found ${pkg.packageManager}.`);
if (pkg.engines?.node !== '>=24 <27') fail(`package.json engines.node must stay ">=24 <27", found ${pkg.engines?.node}.`);
if (pkg.engines?.pnpm !== '>=11 <12') fail(`package.json engines.pnpm must stay ">=11 <12", found ${pkg.engines?.pnpm}.`);

const required = [
  'wxt.config.ts',
  'pnpm-lock.yaml',
  'playwright.config.ts',
  'src/tests/e2e/overlay.spec.ts',
  'tools/store-readiness-check.ts',
  'tools/e2e-readiness-check.ts',
  'tools/production-guard.ts',
];
for (const path of required) {
  if (!existsSync(path)) fail(`required production file is missing: ${path}`);
}

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
if (!workflow.includes('Repository preflight')) fail('CI must include the Repository preflight job.');
if (!workflow.includes('tools/prepare-release-notes.mjs')) fail('CI must generate release notes before release/notification steps.');
if (!workflow.includes('Build Chrome Edge Firefox packages once and run release gates')) fail('CI must build browser packages once and reuse artifacts downstream.');

const storePolicy = readFileSync('wxt.config.ts', 'utf8');
for (const term of [
  'const store = process.env.WXT_STORE === \'1\'',
  'optional_permissions: store ? integrationPermissions : undefined',
  "optional_host_permissions: store ? ['<all_urls>'] : undefined",
  "host_permissions: store ? ['http://127.0.0.1/*']",
]) {
  if (!storePolicy.includes(term)) fail(`store permission policy term missing: ${term}`);
}

function assertFileIncludes(path, term, label = path) {
  const content = readFileSync(path, 'utf8');
  if (!content.includes(term)) fail(`${label} term missing: ${term}`);
}

function assertFilesInclude(paths, term, label) {
  const content = paths.map((path) => readFileSync(path, 'utf8')).join('\n');
  if (!content.includes(term)) fail(`${label} term missing: ${term}`);
}

const overlayRuntimeTerms = [
  'destroyVideoOverlayHost',
  'PICKER_DESTROY_EVENT',
  'writeOverlayClientDiagnostics',
  'observer-paused',
  'destroyCandidatePickerHost',
  'sendBtn.disabled = selected === 0',
];
for (const term of overlayRuntimeTerms) {
  assertFilesInclude(
    [
      'src/content/scanner.ts',
      'src/content/overlay-ui.ts',
      'src/content/overlay-install.ts',
      'src/content/overlay-position.ts',
      'src/content/overlay-types.ts',
    ],
    term,
    'floating overlay runtime hardening',
  );
}

const overlaySettingsTerms = [
  'maxPickerItems',
  'defaultPickerSelection',
  'autoHideWhenIdle',
  'keyboardNudgePx',
];
for (const term of overlaySettingsTerms) {
  assertFileIncludes('src/contracts/settings.schema.ts', term, 'floating overlay settings schema');
}

for (const term of ['settings.overlay.maxPickerItems', 'filteredOut', 'handoffableCandidates']) {
  assertFileIncludes('src/background/message-router.ts', term, 'floating overlay background filtering');
}

const result = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
if (result.status !== 0) fail('Node executable health check failed.');
console.log(`Production preflight passed on ${process.version}.`);
