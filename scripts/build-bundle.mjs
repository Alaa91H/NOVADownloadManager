import { execSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(ROOT, 'dist');
const BUNDLE_DIR = join(ROOT, 'bundle');
const BIN_DIR = join(ROOT, 'bin');
const MANIFEST_PATH = join(BIN_DIR, '.bin-manifest.json');

function latestGitTag() {
  try {
    return execSync('git describe --tags --abbrev=0', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim();
  } catch {
    return '';
  }
}

async function main() {
  const tag = process.env.VITE_APP_VERSION || process.env.GITHUB_REF_NAME || process.env.BUILD_TAG || latestGitTag() || 'v0.0.0';
  console.log(`[bundle] Building NOVA bundle for tag: ${tag}`);

  // Step 1: Build the Vite frontend
  console.log('[bundle] Building Vite frontend...');
  const buildResult = spawnSync('npx', ['vite', 'build'], {
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      VITE_APP_VERSION: tag,
    },
  });
  if (buildResult.status !== 0) {
    throw new Error('Vite build failed');
  }

  // Daemon is now compiled into the Tauri binary (Rust/axum) – no Node.js daemon to bundle.

  // Step 2: Ensure bin directory has the engines
  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
    console.log('[bundle] Warning: No engines in bin/. Run `node scripts/fetch-engines.mjs` first.');
  }

  // Step 3: Create the bundle directory
  const bundleDist = join(BUNDLE_DIR, 'NOVA');
  const bundleBin = join(bundleDist, 'bin');
  const bundleDistDist = join(bundleDist, 'dist');
  mkdirSync(bundleBin, { recursive: true });
  mkdirSync(bundleDistDist, { recursive: true });

  // Copy dist
  await copyRecursive(DIST_DIR, bundleDistDist);

  // Copy engines
  if (existsSync(join(BIN_DIR, 'aria2c.exe'))) {
    copyFileSync(join(BIN_DIR, 'aria2c.exe'), join(bundleBin, 'aria2c.exe'));
  }
  if (existsSync(join(BIN_DIR, 'yt-dlp.exe'))) {
    copyFileSync(join(BIN_DIR, 'yt-dlp.exe'), join(bundleBin, 'yt-dlp.exe'));
  }
  if (existsSync(MANIFEST_PATH)) {
    copyFileSync(MANIFEST_PATH, join(bundleBin, '.bin-manifest.json'));
  }

  // Create info file
  writeFileSync(join(bundleDist, 'README.txt'), [
    'NOVA Download Manager - Standalone Web Bundle',
    '============================================',
    '',
    `Version: ${tag}`,
    '',
    'This bundle contains the frontend and download engines.',
    'The daemon is now embedded in the Tauri desktop application.',
    'Run the NOVA desktop app (via Tauri) to use the full download manager.',
    '',
    'To serve the frontend standalone:',
    '  npx vite preview --port 3199 --host 127.0.0.1 --base ./',
    '',
  ].join('\n'));

  console.log(`[bundle] ✓ Bundle created at: ${bundleDist}`);
  console.log(`[bundle] ✓ Version: ${tag}`);

  if (existsSync(MANIFEST_PATH)) {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    console.log('[bundle] Engine versions:');
    for (const [name, info] of Object.entries(manifest)) {
      console.log(`  - ${name}: ${info.version}`);
    }
  }
}

async function copyRecursive(src, dest) {
  const { readdir, copyFile, mkdir } = await import('node:fs/promises');
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      await copyRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

main().catch((err) => {
  console.error('[bundle] Error:', err.message);
  process.exit(1);
});
