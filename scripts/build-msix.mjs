/*
 * Packages the built Nova Download Manager (Win32 full-trust binary) into an
 * MSIX for Microsoft Store submission / sideloading.
 *
 * Usage: node scripts/build-msix.mjs
 *
 * Requires the Windows 10/11 SDK (makeappx.exe) and a completed Tauri release
 * build (`pnpm run tauri:build`). The Store identity in
 * src-tauri/msix/AppxManifest.xml must be filled in from Partner Center before
 * a real submission; without it the produced .msix is only sideloadable.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_TAURI = join(ROOT, 'src-tauri');
const MANIFEST_SRC = join(SRC_TAURI, 'msix', 'AppxManifest.xml');
const ICON_DIR = join(SRC_TAURI, 'icons');
const OUT_DIR = join(ROOT, 'dist-msix');
const STAGE_DIR = join(OUT_DIR, 'stage');

if (process.platform !== 'win32') {
  console.error('[msix] MSIX packaging is only supported on Windows.');
  process.exit(1);
}

/** Convert an arbitrary version string to the 4-part form MSIX requires. */
function toMsixVersion(raw) {
  const digits = (raw || '0.0.0').replace(/^v/, '').split(/[.+-]/).filter((p) => /^\d+$/.test(p));
  while (digits.length < 4) digits.push('0');
  return digits.slice(0, 4).join('.');
}

/** Locate makeappx.exe from the newest installed Windows SDK. */
function findMakeAppx() {
  const roots = [
    'C:/Program Files (x86)/Windows Kits/10/bin',
    'C:/Program Files/Windows Kits/10/bin',
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root)
      .filter((name) => /^10\./.test(name))
      .sort()
      .reverse();
    for (const version of versions) {
      const candidate = join(root, version, 'x64', 'makeappx.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Recursively copy a directory tree. */
function copyDir(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

function main() {
  const makeappx = findMakeAppx();
  if (!makeappx) {
    console.error('[msix] makeappx.exe not found; install the Windows 10/11 SDK.');
    process.exit(1);
  }

  const exePath = join(SRC_TAURI, 'target', 'release', 'nova.exe');
  if (!existsSync(exePath)) {
    console.error(`[msix] Built binary missing: ${exePath}. Run "pnpm run tauri:build" first.`);
    process.exit(1);
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });

  // 1. Application payload: the executable and its staged resources.
  copyFileSync(exePath, join(STAGE_DIR, 'nova.exe'));
  const resourcesDir = join(SRC_TAURI, 'resources');
  if (existsSync(resourcesDir)) copyDir(resourcesDir, join(STAGE_DIR, 'resources'));

  // 2. Visual assets (approximations from the shipped icons; refine for Store).
  const assetsDir = join(STAGE_DIR, 'Assets');
  mkdirSync(assetsDir, { recursive: true });
  const assetMap = {
    'StoreLogo.png': '64x64.png',
    'Square44x44Logo.png': '64x64.png',
    'Square150x150Logo.png': '128x128.png',
    'Wide310x150Logo.png': '128x128@2x.png',
  };
  for (const [target, source] of Object.entries(assetMap)) {
    const from = join(ICON_DIR, source);
    if (existsSync(from)) copyFileSync(from, join(assetsDir, target));
    else console.warn(`[msix] Missing icon ${source}; ${target} not staged.`);
  }

  // 3. Manifest with the build version injected.
  const version = toMsixVersion(
    process.env.VITE_APP_VERSION ||
      process.env.BUILD_TAG ||
      JSON.parse(readFileSync(join(SRC_TAURI, 'tauri.conf.json'), 'utf8')).version,
  );
  const manifest = readFileSync(MANIFEST_SRC, 'utf8').replace(
    /(<Identity[^>]*\bVersion=")[^"]*(")/,
    `$1${version}$2`,
  );
  writeFileSync(join(STAGE_DIR, 'AppxManifest.xml'), manifest);

  // 4. Pack.
  const outFile = join(OUT_DIR, `Nova-Download-Manager-${version}-x64.msix`);
  console.log(`[msix] Packing ${outFile} with ${makeappx}`);
  const result = spawnSync(makeappx, ['pack', '/d', STAGE_DIR, '/p', outFile, '/o'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error(`[msix] makeappx failed (exit ${String(result.status)}).`);
    process.exit(1);
  }
  console.log(`[msix] Created ${outFile} (${(statSync(outFile).size / 1048576).toFixed(1)} MB)`);
  console.log('[msix] Note: fill in the Partner Center identity and sign before Store submission.');
}

main();
