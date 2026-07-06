import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stamps the release tag (for example v1.2.3) into every versioned project file
// so installers, the app, the daemon, and the browser extension all report the
// same version. Sources, in priority order: CLI argument, BUILD_TAG,
// VITE_APP_VERSION, GITHUB_REF_NAME, then the latest reachable git tag.
// Pass --optional to keep the current versions and exit successfully when no
// tag can be resolved (local dev builds in repos without tags).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAG_PATTERN = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

const args = process.argv.slice(2);
const optional = args.includes('--optional');
const explicitTag = args.find((arg) => arg !== '--optional');

function resolveTag() {
  const candidates = [
    explicitTag,
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

// Browser manifests only accept 1-4 dotted integers, so v1.2.3-beta.4 becomes
// 1.2.3.4 (same normalization as browser-extension/wxt.config.ts and build.py).
/** @param {string} version */
function toManifestVersion(version) {
  const base = version.split('+', 1)[0] ?? '';
  if (/^\d+\.\d+\.\d+(\.\d+)?$/.test(base)) return base;
  const prerelease = /^(\d+\.\d+\.\d+)-([0-9A-Za-z][0-9A-Za-z.-]*)$/.exec(base);
  if (prerelease) {
    const numeric = prerelease[2]
      .split('.')
      .filter((part) => /^\d+$/.test(part))
      .at(-1) ?? '0';
    return `${prerelease[1]}.${numeric}`;
  }
  throw new Error(`Cannot express "${version}" as a browser manifest version.`);
}

// Replaces only the top-level "version" line so the file keeps its original
// formatting (root package.json is 4-space indented, the rest 2-space).
/** @param {string} path @param {string} version */
function updateJsonVersion(path, version) {
  const source = readFileSync(path, 'utf8');
  const pattern = /^(\s*)"version":\s*"[^"]*"/m;
  if (!pattern.test(source)) {
    throw new Error(`No "version" field found in ${path}`);
  }
  const updated = source.replace(pattern, `$1"version": "${version}"`);
  if (updated === source) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

/** @param {string} path @param {string} version */
function updateCargoToml(path, version) {
  const source = readFileSync(path, 'utf8');
  const updated = source.replace(/^version = "[^"]*"/m, `version = "${version}"`);
  if (updated === source) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

/** @param {string} path @param {string} version */
function updateCargoLock(path, version) {
  if (!existsSync(path)) return false;
  const source = readFileSync(path, 'utf8');
  const updated = source.replace(
    /(\[\[package\]\]\r?\n(?:[^[\r\n].*\r?\n)*?name = "nova"\r?\nversion = ")[^"]*(")/,
    `$1${version}$2`
  );
  if (updated === source) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

const tag = resolveTag();
if (!tag) {
  if (optional) {
    console.log('[apply-version] No version tag found; keeping existing versions (dev build).');
    process.exit(0);
  }
  console.error('[apply-version] No version tag found. Pass one explicitly: node scripts/apply-version.mjs v1.2.3');
  process.exit(1);
}

const version = tag.replace(/^v/, '');
const manifestVersion = toManifestVersion(version);
console.log(`[apply-version] Stamping version ${version} (tag ${tag}, manifest ${manifestVersion})`);

const targets = [
  ['package.json', () => updateJsonVersion(join(ROOT, 'package.json'), version)],
  ['src-tauri/tauri.conf.json', () => updateJsonVersion(join(ROOT, 'src-tauri', 'tauri.conf.json'), version)],
  ['src-tauri/Cargo.toml', () => updateCargoToml(join(ROOT, 'src-tauri', 'Cargo.toml'), version)],
  ['src-tauri/Cargo.lock', () => updateCargoLock(join(ROOT, 'src-tauri', 'Cargo.lock'), version)],
  ['browser-extension/package.json', () => updateJsonVersion(join(ROOT, 'browser-extension', 'package.json'), version)],
  ['browser-extension/src/manifest.json', () => updateJsonVersion(join(ROOT, 'browser-extension', 'src', 'manifest.json'), manifestVersion)]
];

for (const [label, apply] of targets) {
  console.log(`[apply-version]   ${label}: ${apply() ? 'updated' : 'already up to date'}`);
}
