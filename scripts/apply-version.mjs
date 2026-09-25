import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAG_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

const args = process.argv.slice(2);
const optional = args.includes('--optional');
const explicitTag = args.find((arg) => arg !== '--optional' && arg !== '--');

function resolveTag() {
  const candidates = [explicitTag, process.env.BUILD_TAG, process.env.GITHUB_REF_NAME];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && TAG_PATTERN.test(value)) return value;
  }
  try {
    const described = execSync('git describe --tags --abbrev=0', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (TAG_PATTERN.test(described)) return described;
  } catch {}
  return '';
}

function toManifestVersion(version) {
  const [base = '', build = ''] = version.split('+', 2);
  if (/^\d+\.\d+\.\d+(\.\d+)?$/.test(base)) {
    const numericBuild = build.split('.').filter((part) => /^\d+$/.test(part)).at(-1);
    return numericBuild ? `${base}.${numericBuild}` : base;
  }
  const prerelease = /^(\d+\.\d+\.\d+)-([0-9A-Za-z][0-9A-Za-z.-]*)$/.exec(base);
  if (!prerelease) throw new Error(`Cannot express "${version}" as a browser manifest version.`);
  const numeric = prerelease[2].split('.').filter((part) => /^\d+$/.test(part)).at(-1) ?? '0';
  return `${prerelease[1]}.${numeric}`;
}

function updateJsonVersion(path, version) {
  const source = readFileSync(path, 'utf8');
  const updated = source.replace(/^(\s*)"version":\s*"[^"]*"/m, `$1"version": "${version}"`);
  if (updated === source) return false;
  writeFileSync(path, updated, 'utf8');
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
    /(\[\[package\]\]\r?\n(?:[^[\r\n].*\r?\n)*?name = "nova"\r?\nversion = ")[^"]*(")/,
    `$1${version}$2`,
  );
  if (updated === source) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

function updateNativeCMake(path, version) {
  const source = readFileSync(path, 'utf8');
  const numeric = version.split(/[+-]/, 1)[0];
  let updated = source.replace(
    /project\(NOVANative VERSION [^)]+ LANGUAGES CXX\)/,
    `project(NOVANative VERSION ${numeric} LANGUAGES CXX)`,
  );
  updated = updated.replace(
    /set\(NOVA_APP_VERSION "[^"]*"\)/,
    `set(NOVA_APP_VERSION "${version}")`,
  );
  if (updated === source) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

function updateParityManifest(path, version) {
  const source = readFileSync(path, 'utf8');
  const updated = source.replace(
    /("nativePreviewVersion"\s*:\s*")[^"]*(")/,
    `$1${version}$2`,
  );
  if (updated === source) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

function updateAndroidGradle(path, version) {
  const source = readFileSync(path, 'utf8');
  const updated = source.replace(
    /(versionName\s*=\s*")[^"]*(")/,
    `$1${version}$2`,
  );
  if (updated === source) return false;
  writeFileSync(path, updated, 'utf8');
  return true;
}

const tag = resolveTag();
if (!tag) {
  if (optional) {
    console.log('[apply-version] No version tag found; keeping existing versions.');
    process.exit(0);
  }
  console.error('[apply-version] Pass a release tag, for example v2.5.0.');
  process.exit(1);
}

const version = tag.replace(/^v/, '');
const manifestVersion = toManifestVersion(version);
console.log(`[apply-version] Stamping native release ${version} (browser manifest ${manifestVersion})`);

const targets = [
  ['package.json', () => updateJsonVersion(join(ROOT, 'package.json'), version)],
  ['desktop-native/CMakeLists.txt', () => updateNativeCMake(join(ROOT, 'desktop-native', 'CMakeLists.txt'), version)],
  ['desktop-native/parity/parity-manifest.json', () => updateParityManifest(join(ROOT, 'desktop-native', 'parity', 'parity-manifest.json'), version)],
  ['src-tauri/Cargo.toml', () => updateCargoToml(join(ROOT, 'src-tauri', 'Cargo.toml'), version)],
  ['src-tauri/Cargo.lock', () => updateCargoLock(join(ROOT, 'src-tauri', 'Cargo.lock'), version)],
  ['android/app/build.gradle.kts', () => updateAndroidGradle(join(ROOT, 'android', 'app', 'build.gradle.kts'), version)],
  ['browser-extension/package.json', () => updateJsonVersion(join(ROOT, 'browser-extension', 'package.json'), version)],
  ['browser-extension/src/manifest.json', () => updateJsonVersion(join(ROOT, 'browser-extension', 'src', 'manifest.json'), manifestVersion)],
];

for (const [label, apply] of targets) {
  console.log(`[apply-version]   ${label}: ${apply() ? 'updated' : 'already up to date'}`);
}
