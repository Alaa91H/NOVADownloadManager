#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
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

function walk(dir, predicate, out = []) {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return out;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.wxt', '.output', 'dist', 'coverage', 'playwright-report', 'test-results', '__pycache__', '.pytest_cache'].includes(entry.name)) continue;
    const rel = path.join(dir, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) walk(rel, predicate, out);
    else if (predicate(rel)) out.push(rel);
  }
  return out;
}

function assertIncludes(file, text, message) {
  if (!read(file).includes(text)) fail(`${file}: ${message}`);
}

function assertRegex(file, regex, message) {
  if (!regex.test(read(file))) fail(`${file}: ${message}`);
}

const packageJson = parseJson('package.json') ?? {};
const scripts = packageJson.scripts ?? {};
for (const script of ['audit:offline', 'audit:release', 'signoff:production', 'verify:offline', 'verify:production', 'verify:release:reuse-build', 'release:notes']) {
  if (typeof scripts[script] !== 'string') fail(`package.json script missing: ${script}`);
}
if (!String(scripts['verify:offline'] ?? '').includes('pnpm audit:release')) {
  fail('verify:offline must include pnpm audit:release so store/release policy is checked before heavy gates.');
}
if (scripts['audit:release'] !== 'node tools/release-submission-audit.mjs') {
  fail('audit:release must run tools/release-submission-audit.mjs.');
}
if (scripts['signoff:production'] !== 'node tools/final-production-signoff.mjs') {
  fail('signoff:production must run tools/final-production-signoff.mjs.');
}

for (const file of [
  'scripts/bootstrap-node24-pnpm.sh',
  '../docs/extension/ci-templates/Dockerfile.ci',
  '../docs/extension/ci-templates/devcontainer.json',
]) {
  if (!exists(file)) fail(`release readiness file missing: ${file}`);
}

const wxt = read('wxt.config.ts');
for (const term of [
  "const corePermissions = ['storage', 'contextMenus', 'nativeMessaging', 'alarms', 'notifications', 'activeTab']",
  "const integrationPermissions = ['downloads', 'webRequest', 'scripting', 'tabs']",
  'permissions: store ? corePermissions : [...corePermissions, ...integrationPermissions]',
  'optional_permissions: store ? integrationPermissions : undefined',
  "host_permissions: store ? ['http://127.0.0.1/*']",
  "optional_host_permissions: store ? ['<all_urls>'] : undefined",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
]) {
  if (!wxt.includes(term)) fail(`wxt.config.ts release policy term missing: ${term}`);
}
if (/unsafe-(eval|inline)/i.test(wxt)) fail('wxt.config.ts must not permit unsafe-eval or unsafe-inline.');

const sourceManifest = parseJson('src/manifest.json');
if (sourceManifest) {
  const requiredDevPermissions = ['storage', 'contextMenus', 'nativeMessaging', 'alarms', 'notifications'];
  for (const permission of requiredDevPermissions) {
    if (!sourceManifest.permissions?.includes(permission)) fail(`src/manifest.json missing base permission ${permission}`);
  }
  const csp = sourceManifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes("script-src 'self'")) fail('src/manifest.json CSP must restrict scripts to self.');
  if (/unsafe-(eval|inline)/i.test(csp)) fail('src/manifest.json CSP must not include unsafe-eval or unsafe-inline.');
}

const policyDocs = {
  '../docs/extension/PRIVACY.md': ['local', 'token', 'diagnostic', 'no telemetry'],
  '../docs/extension/SECURITY.md': ['token', 'redact', 'local-only', 'CSP'],
  '../docs/extension/PERMISSIONS.md': ['optional', '<all_urls>', 'downloads', 'webRequest'],
  '../docs/release/STORE_COMPLIANCE.md': ['remote code', 'optional', 'privacy'],
  '../docs/release/STORE_REVIEW_CHECKLIST.md': ['Chrome Web Store', 'permission', 'privacy'],
  '../docs/release/STORE_PUBLISHING.md': ['build:store', 'release', 'review'],
  '../docs/release/TESTING.md': ['Playwright', 'Vitest', 'pytest'],
  '../docs/release/RELEASE.md': ['release', 'artifact', 'version'],
};
const docsDirExists = exists('../docs');
for (const [file, terms] of Object.entries(policyDocs)) {
  if (!docsDirExists) continue;
  if (!exists(file)) {
    note(`optional policy document is absent: ${file}`);
    continue;
  }
  const lower = read(file).toLowerCase();
  for (const term of terms) {
    if (!lower.includes(term.toLowerCase())) note(`optional policy document ${file} does not mention ${term}`);
  }
}

const runtimeFiles = walk('src', (rel) => /\.(ts|tsx|js|mjs|cjs|html)$/.test(rel) && !rel.startsWith('src/tests/'));
const runtimeViolations = [];
for (const file of runtimeFiles) {
  const text = read(file);
  if (/\beval\s*\(/.test(text)) runtimeViolations.push(`${file}: eval() is not allowed`);
  if (/new\s+Function\s*\(/.test(text)) runtimeViolations.push(`${file}: Function constructor is not allowed`);
  if (/import\s*\(\s*['"]https?:\/\//.test(text)) runtimeViolations.push(`${file}: remote dynamic import is not allowed`);
  if (/(script|iframe)\s+src\s*=\s*['"]https?:\/\//i.test(text)) runtimeViolations.push(`${file}: remote executable/frame source is not allowed`);
  if (/https?:\/\/(?!127\.0\.0\.1|localhost|example\.com|cdn\.example\.com|files\.example\.com|docs\.example\.com|apps\.example\.com|tracker\.example\.org|s3\.amazonaws\.com)/i.test(text)) {
    runtimeViolations.push(`${file}: runtime source contains a non-loopback remote HTTP(S) literal`);
  }
}
if (runtimeViolations.length) fail(`runtime release policy violations:\n${runtimeViolations.join('\n')}`);
note(`scanned ${runtimeFiles.length} runtime files for remote-code and release-policy violations`);

const releaseNotes = read('tools/prepare-release-notes.mjs');
for (const term of ['RELEASE_NOTES.md', 'DOWNLOADS.md', 'RELEASE_NOTIFICATION.txt', 'releases/download', 'Change log']) {
  if (!releaseNotes.includes(term)) fail(`tools/prepare-release-notes.mjs release-note term missing: ${term}`);
}
if (releaseNotes.includes('build succeeded')) fail('release notification text must not describe ordinary build success');
if (!releaseNotes.includes('tag release published')) fail('release notification text must describe a tag release publication');
const telegram = read('scripts/telegram-release-notify.py');
for (const term of ['RELEASE_NOTIFICATION_FILE', 'Downloads:', 'Change log:', 'TELEGRAM_LIMIT', 'DEFAULT_PARSE_MODE = "HTML"', 'parse_mode', 'disable_web_page_preview']) {
  if (!telegram.includes(term)) fail(`scripts/telegram-release-notify.py notification term missing: ${term}`);
}

const signoff = read('tools/final-production-signoff.mjs');
for (const term of ['production preflight', 'runPreflight()', 'dependency-heavy production gates', 'Executed-check score', 'Total-gate score']) {
  if (!signoff.includes(term)) fail(`tools/final-production-signoff.mjs release signoff term missing: ${term}`);
}

const workflow = read('../docs/extension/ci-templates/legacy-extension-ci.yml');
for (const term of [
  'Repository preflight',
  'Run production preflight',
  'Run offline production audit',
  'Run release submission audit',
  'needs: preflight',
  'pnpm verify:release:reuse-build',
  'pnpm test:e2e',
  'actions/upload-artifact@v7.0.1',
  'Build Chrome Edge Firefox packages once and run release gates',
  'Run Playwright smoke tests against the existing Chromium build',
  'Download unpacked browser builds',
  'actions/download-artifact@v8.0.1',
  'nova-browser-extension-unpacked',
  'EXTENSION_UNPACKED_DIR: dist/chromium',
  'telegram-release:',
  'body_path: ${{ steps.notes.outputs.body_path }}',
]) {
  if (!workflow.includes(term)) fail(`CI workflow missing release gate term: ${term}`);
}
for (const term of ['continue-on-error: true', 'Summarize quality gates without failing early', 'Summarize package and release gates without failing early', 'Pipeline failed after collecting all available gates', "row.outputs.failed === 'true'", 'ci-quality-gates-${{ github.run_number }}', 'ci-package-build-${{ github.run_number }}']) {
  if (!workflow.includes(term)) fail(`CI workflow missing collect-all failure term: ${term}`);
}


if (workflow.includes('telegram-build-success:')) fail('CI must not include a Telegram build-success notification job; notify only after successful tag release publication.');
for (const term of ["github.event_name == 'push'", "github.ref_type == 'tag'", "startsWith(github.ref_name, 'v')", "needs.release.result == 'success'"]) {
  if (!workflow.includes(term)) fail(`Telegram release notification must be tag-only and success-gated: ${term}`);
}

assertIncludes('../docs/extension/ci-templates/setup-extension-ci-action.yml', 'version: 11.6.0', 'CI must pin pnpm 11.6.0.');
assertIncludes('../docs/extension/ci-templates/setup-extension-ci-action.yml', 'node-version-file: .node-version', 'CI must use Node version from root .node-version when template is copied to root .github.');
assertIncludes('../docs/extension/ci-templates/Dockerfile.ci', 'FROM node:24', '../docs/extension/ci-templates/Dockerfile.ci must pin a Node 24 base image.');
assertIncludes('../docs/extension/ci-templates/Dockerfile.ci', 'corepack prepare pnpm@11.6.0 --activate', '../docs/extension/ci-templates/Dockerfile.ci must activate pnpm 11.6.0.');
assertIncludes('scripts/bootstrap-node24-pnpm.sh', 'corepack prepare "pnpm@${REQUIRED_PNPM_VERSION}" --activate', 'bootstrap script must activate pinned pnpm.');
assertRegex('../docs/extension/ci-templates/devcontainer.json', /"image"\s*:\s*"mcr\.microsoft\.com\/devcontainers\/javascript-node:1-24-bookworm"/, 'devcontainer must use Node 24 image.');

const forbiddenArtifacts = walk('.', (rel) => /(^|\/)(node_modules|\.wxt|\.output|dist|coverage|playwright-report|test-results|__pycache__|\.pytest_cache)(\/|$)/.test(rel));
if (forbiddenArtifacts.length) fail(`source package contains generated artifacts: ${forbiddenArtifacts.slice(0, 12).join(', ')}`);

for (const message of notes) console.log(`[release-audit:ok] ${message}`);
if (failures.length) {
  console.error('\nRelease submission audit failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Release submission audit passed.');
