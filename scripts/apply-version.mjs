import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// Stamps the release tag (for example v1.2.3) into every versioned project file
// so installers, the app, the daemon, and the browser extension all report the
// same version. Sources, in priority order: CLI argument, BUILD_TAG,
// VITE_APP_VERSION, GITHUB_REF_NAME, then the latest reachable git tag.

const ROOT = resolve(process.cwd());
const TAG_PATTERN = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

function resolveTag() {
  const candidates = [
    process.argv[2],
    process.env.BUILD_TAG,
    process.env.VITE_APP_VERSION,
    process.env.GITHUB_REF_NAME
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && TAG_PATTERN.test(value)) return value;
  }
  try {
    const described = execSync('git describe --tags --abbrev=0', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim();
    if (TAG_PATTERN.test(described)) return described;
  } catch {
    // No git tags yet; fall through.
  }
  return '';
}

function updateJsonVersion(path, version) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.version === version) return false;
  data.version = version;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return true;
}

function updateCargoToml(path, version) {
  const source = readFileSync(path, 'utf8');
  const updated = source.replace(/^version = "[^"]*"/m, `version = "${version}"`);
  if (updated === source) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

function updateCargoLock(path, version) {
  if (!existsSync(path)) return false;
  const source = readFileSync(path, 'utf8');
  const updated = source.replace(
    /(\[\[package\]\]\r?\nname = "nova"\r?\nversion = ")[^"]*(")/,
    `$1${version}$2`
  );
  if (updated === source) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

const tag = resolveTag();
if (!tag) {
  console.error('[apply-version] No version tag found. Pass one explicitly: node scripts/apply-version.mjs v1.2.3');
  process.exit(1);
}

const version = tag.replace(/^v/, '');
console.log(`[apply-version] Stamping version ${version} (tag ${tag})`);

const targets = [
  ['package.json', () => updateJsonVersion(join(ROOT, 'package.json'), version)],
  ['src-tauri/tauri.conf.json', () => updateJsonVersion(join(ROOT, 'src-tauri', 'tauri.conf.json'), version)],
  ['src-tauri/Cargo.toml', () => updateCargoToml(join(ROOT, 'src-tauri', 'Cargo.toml'), version)],
  ['src-tauri/Cargo.lock', () => updateCargoLock(join(ROOT, 'src-tauri', 'Cargo.lock'), version)],
  ['browser-extension/package.json', () => updateJsonVersion(join(ROOT, 'browser-extension', 'package.json'), version)]
];

for (const [label, apply] of targets) {
  console.log(`[apply-version]   ${label}: ${apply() ? 'updated' : 'already up to date'}`);
}
