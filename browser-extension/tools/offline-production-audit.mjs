#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const failures = [];
const warnings = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function note(message) {
  notes.push(message);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function parseJson(rel) {
  try {
    return JSON.parse(read(rel));
  } catch (error) {
    fail(`${rel} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function walk(dir, predicate, output = []) {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return output;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (['node_modules', '.git', '.wxt', '.output', 'dist', 'coverage', 'playwright-report', 'test-results', '__pycache__', '.pytest_cache'].includes(entry.name)) continue;
    const rel = path.join(dir, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) walk(rel, predicate, output);
    else if (predicate(rel)) output.push(rel);
  }
  return output;
}

function assertIncludes(file, text, message) {
  const content = read(file);
  if (!content.includes(text)) fail(`${file}: ${message}`);
}

function assertRegex(file, regex, message) {
  const content = read(file);
  if (!regex.test(content)) fail(`${file}: ${message}`);
}

const requiredFiles = [
  'package.json',
  '../pnpm-lock.yaml',
  '../pnpm-workspace.yaml',
  '../.node-version',
  '../docs/extension/ci-templates/legacy-extension-ci.yml',
  '../docs/extension/ci-templates/setup-extension-ci-action.yml',
  'src/content/scanner.ts',
  'src/contracts/settings.schema.ts',
  'src/contracts/messages.schema.ts',
  'src/background/message-router.ts',
  'tools/release-submission-audit.mjs',
  'tools/final-production-signoff.mjs',
  'tools/prepare-release-notes.mjs',
  'scripts/bootstrap-node24-pnpm.sh',
  '../docs/extension/ci-templates/Dockerfile.ci',
  '../docs/extension/ci-templates/devcontainer.json',
];

for (const file of requiredFiles) {
  if (!exists(file)) fail(`required production file missing: ${file}`);
}

const packageJson = parseJson('package.json') ?? {};
if (packageJson.packageManager !== 'pnpm@11.6.0') fail('package.json packageManager must remain pnpm@11.6.0');
if (packageJson.engines?.node !== '>=24 <27') fail('package.json engines.node must remain >=24 <27');
if (packageJson.engines?.pnpm !== '>=11 <12') fail('package.json engines.pnpm must remain >=11 <12');
if (read('../.node-version').trim() !== '24') fail('../.node-version must stay pinned to Node 24');

const scripts = packageJson.scripts ?? {};
const requiredScripts = [
  'preflight:production',
  'audit:offline',
  'verify:offline',
  'verify:production',
  'audit:release',
  'signoff:production',
  'guard:e2e',
  'validate:manifests',
  'verify:store',
  'verify:highest',
  'verify:release:reuse-build',
  'release:notes',
  'ci',
];
for (const script of requiredScripts) {
  if (typeof scripts[script] !== 'string') fail(`package.json script missing: ${script}`);
}
if (typeof scripts.ci === 'string' && !scripts.ci.startsWith('pnpm verify:offline &&')) {
  fail('package.json ci must start with pnpm verify:offline before dependency-heavy gates');
}
if (scripts['audit:offline'] !== 'node tools/offline-production-audit.mjs') {
  fail('package.json audit:offline must run tools/offline-production-audit.mjs');
}
if (scripts['verify:offline'] !== 'pnpm preflight:production && pnpm audit:offline && pnpm audit:release && pnpm verify:nova-sync') {
  fail('package.json verify:offline must chain preflight, offline audit, release audit, and NOVA feature parity');
}
if (scripts['audit:release'] !== 'node tools/release-submission-audit.mjs') {
  fail('package.json audit:release must run tools/release-submission-audit.mjs');
}
if (scripts['signoff:production'] !== 'node tools/final-production-signoff.mjs') {
  fail('package.json signoff:production must run tools/final-production-signoff.mjs');
}

const workflow = read('../docs/extension/ci-templates/legacy-extension-ci.yml');
if (!workflow.includes('run: node tools/preflight.mjs\n      - name: Run offline production audit\n        run: node tools/offline-production-audit.mjs\n      - name: Run release submission audit\n        run: node tools/release-submission-audit.mjs')) {
  fail('CI preflight job must run offline and release audits immediately after production preflight');
}
for (const term of ['Download unpacked browser builds', 'nova-browser-extension-unpacked', 'EXTENSION_UNPACKED_DIR: dist/chromium', 'Run Playwright smoke tests against the existing Chromium build']) {
  if (!workflow.includes(term)) fail(`CI E2E artifact-reuse term missing: ${term}`);
}
if (workflow.includes('node scripts/run-python.js build.py --clean --target chromium')) {
  fail('CI browser E2E must reuse package-build artifacts and must not rebuild Chromium');
}
if (!workflow.includes('needs: [preflight, quality-gates, package-build, browser-e2e]')) {
  fail('CI pipeline result must depend on the optimized non-duplicating validation jobs');
}
for (const term of ['quality-gates:', 'Build Chrome Edge Firefox packages once and run release gates', 'pnpm build:store', 'Upload unpacked browser builds for downstream smoke tests', 'Run Playwright smoke tests against the existing Chromium build', 'telegram-release:', 'body_path: ${{ steps.notes.outputs.body_path }}']) {
  if (!workflow.includes(term)) fail(`CI workflow missing optimized release term: ${term}`);
}
for (const term of ['continue-on-error: true', 'Summarize quality gates without failing early', 'Summarize package and release gates without failing early', 'Pipeline failed after collecting all available gates', "row.outputs.failed === 'true'", 'ci-quality-gates-${{ github.run_number }}', 'ci-package-build-${{ github.run_number }}']) {
  if (!workflow.includes(term)) fail(`CI workflow missing collect-all failure term: ${term}`);
}
if (workflow.includes('telegram-build-success:')) {
  fail('CI must not send Telegram notifications for ordinary build success');
}
for (const term of ["github.event_name == 'push'", "github.ref_type == 'tag'", "startsWith(github.ref_name, 'v')", "needs.release.result == 'success'"]) {
  if (!workflow.includes(term)) fail(`Telegram release notification must be tag-only and success-gated: ${term}`);
}
if ((workflow.match(/RELEASE_ACTOR: \$\{\{ github\.actor \}\}/g) ?? []).length < 1) {
  fail('CI release notifications must define RELEASE_ACTOR for generated notes');
}
assertIncludes('../docs/extension/ci-templates/setup-extension-ci-action.yml', 'version: 11.6.0', 'pnpm action must pin version 11.6.0');
assertIncludes('../docs/extension/ci-templates/setup-extension-ci-action.yml', 'node-version-file: .node-version', 'setup-node must use root .node-version when template is copied to root .github');
assertIncludes('../docs/extension/ci-templates/setup-extension-ci-action.yml', 'package-manager-cache: false', 'setup-node cache must stay disabled until lockfile policy changes');
assertIncludes('../docs/extension/ci-templates/Dockerfile.ci', 'FROM node:24', '../docs/extension/ci-templates/Dockerfile.ci must pin Node 24');
assertIncludes('../docs/extension/ci-templates/Dockerfile.ci', 'corepack prepare pnpm@11.6.0 --activate', '../docs/extension/ci-templates/Dockerfile.ci must activate pnpm 11.6.0');
assertIncludes('scripts/bootstrap-node24-pnpm.sh', 'corepack prepare "pnpm@${REQUIRED_PNPM_VERSION}" --activate', 'bootstrap script must activate pinned pnpm');
assertRegex('../docs/extension/ci-templates/devcontainer.json', /"image"\s*:\s*"mcr\.microsoft\.com\/devcontainers\/javascript-node:1-24-bookworm"/, 'devcontainer must use Node 24 image');

const sourceManifest = exists('src/manifest.json') ? read('src/manifest.json') : '';
const wxtConfig = read('wxt.config.ts');
for (const term of ['WXT_STORE', 'optional_permissions', 'optional_host_permissions']) {
  if (!wxtConfig.includes(term)) fail(`wxt.config.ts store permission policy term missing: ${term}`);
}
if (sourceManifest.includes('"<all_urls>"') && !wxtConfig.includes('optional_host_permissions')) {
  fail('source manifest contains <all_urls> but store build does not move hosts to optional_host_permissions');
}

const signoff = read('tools/final-production-signoff.mjs');
for (const term of ['production preflight', 'runPreflight()', 'Executed-check score', 'Total-gate score', 'Strict mode converts them to failures']) {
  if (!signoff.includes(term)) fail(`tools/final-production-signoff.mjs final signoff gate term missing: ${term}`);
}

const dataSettings = read('src/i18n/locales/en.ts');
for (const key of ['candidate.detail.size', 'candidate.detail.bitrate', 'candidate.detail.duration', 'candidate.detail.resolution']) {
  if (!dataSettings.includes(key)) fail(`en.ts missing candidate detail translation key: ${key}`);
}

const releaseNotes = read('tools/prepare-release-notes.mjs');
for (const term of ['RELEASE_NOTES.md', 'DOWNLOADS.md', 'RELEASE_NOTIFICATION.txt', 'releases/download', 'Change log']) {
  if (!releaseNotes.includes(term)) fail(`prepare-release-notes missing professional release-note term: ${term}`);
}
if (releaseNotes.includes('build succeeded')) fail('release notification generator must not describe ordinary build success');
if (!releaseNotes.includes('tag release published')) fail('release notification generator must describe successful tag release publication');
const telegram = read('scripts/telegram-release-notify.py');
for (const term of ['RELEASE_NOTIFICATION_FILE', 'Downloads:', 'Change log:', 'TELEGRAM_LIMIT', 'DEFAULT_PARSE_MODE = "HTML"', 'parse_mode', 'disable_web_page_preview']) {
  if (!telegram.includes(term)) fail(`telegram-release-notify.py missing professional notification term: ${term}`);
}

const localeFiles = walk('src/i18n/locales', (rel) => rel.endsWith('.ts'));
note(`checked ${localeFiles.length} locale files`);

const forbiddenArtifacts = walk('.', (rel) => /(^|\/)(__pycache__|\.pytest_cache|node_modules|\.wxt|dist|coverage|playwright-report|test-results)(\/|$)/.test(rel));
if (forbiddenArtifacts.length > 0) fail(`generated artifacts must not be packaged in source archive: ${forbiddenArtifacts.slice(0, 10).join(', ')}`);

const jsFiles = walk('.', (rel) => /\.(mjs|cjs|js)$/.test(rel));
for (const rel of jsFiles) {
  try {
    new Function(read(rel));
  } catch (error) {
    // ESM import/export syntax is not valid inside Function; validate obvious syntax-only files separately.
    if (!read(rel).includes('import ') && !read(rel).includes('export ')) {
      fail(`${rel} has invalid JavaScript syntax: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

try {
  const ts = require('typescript');
  const tsFiles = walk('.', (rel) => /\.(ts|tsx|mts|cts)$/.test(rel));
  const syntaxErrors = [];
  for (const rel of tsFiles) {
    const source = read(rel);
    const scriptKind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.ESNext, true, scriptKind);
    for (const diagnostic of sourceFile.parseDiagnostics) {
      syntaxErrors.push(`${rel}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    }
  }
  if (syntaxErrors.length > 0) fail(`TypeScript parse errors:\n${syntaxErrors.join('\n')}`);
  else note(`parsed ${tsFiles.length} TypeScript/TSX files with TypeScript ${ts.version}`);
} catch (error) {
  warn(`TypeScript parser unavailable before dependency install; skipped TS parse audit (${error instanceof Error ? error.message : String(error)})`);
}

for (const rel of ['package.json']) {
  const raw = read(rel);
  if (raw.includes('TODO') || raw.includes('FIXME')) fail(`${rel} must not contain TODO/FIXME markers`);
}

if (warnings.length) {
  for (const message of warnings) console.warn(`[offline-audit:warn] ${message}`);
}
for (const message of notes) console.log(`[offline-audit:ok] ${message}`);
if (failures.length > 0) {
  console.error('\nOffline production audit failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Offline production audit passed.');
