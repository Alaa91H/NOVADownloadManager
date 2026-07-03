import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const DIST_DIR = join(ROOT, 'dist');
const BUNDLE_DIR = join(ROOT, 'bundle');
const BIN_DIR = join(ROOT, 'bin');
const MANIFEST_PATH = join(BIN_DIR, '.bin-manifest.json');

// Files from the project root to include in the bundle
const EXTRA_FILES = ['package.json', '.env.example', 'README.md'];

async function main() {
  const tag = process.env.VITE_APP_VERSION || process.env.GITHUB_REF_NAME || process.env.BUILD_TAG || 'v0.0.0';
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

  // Step 2: Transpile the daemon to JS
  console.log('[bundle] Transpiling daemon...');
  const daemonResult = spawnSync('npx', ['tsx', '--eval', 'require("esbuild").buildSync({entryPoints:["server/nova-daemon.ts"],outfile:"dist/nova-daemon.cjs",platform:"node",target:"node20",bundle:true,format:"cjs",external:["express"]})'], {
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
  });
  // Fallback: just copy the ts file and let the user run with tsx
  if (daemonResult.status !== 0) {
    console.log('[bundle] esbuild bundle failed, copying daemon source as fallback...');
    const serverDir = join(DIST_DIR, 'server');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'nova-daemon.mjs'),
      `import { spawn } from 'node:child_process'; console.log('[NOVA] This is a placeholder. Run: npx tsx server/nova-daemon.ts');`,
    );
  }

  // Step 3: Ensure bin directory has the engines
  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
    console.log('[bundle] Warning: No engines in bin/. Run `node scripts/fetch-engines.mjs` first.');
  }

  // Step 4: Create the bundle directory
  const bundleDist = join(BUNDLE_DIR, 'NOVA');
  const bundleBin = join(bundleDist, 'bin');
  mkdirSync(bundleBin, { recursive: true });

  // Copy dist
  await copyRecursive(DIST_DIR, join(bundleDist, 'dist'));

  // Copy server
  const bundleServer = join(bundleDist, 'server');
  mkdirSync(bundleServer, { recursive: true });
  if (existsSync(join(ROOT, 'server'))) {
    await copyRecursive(join(ROOT, 'server'), bundleServer);
  }
  // Copy scripts
  const bundleScripts = join(bundleDist, 'scripts');
  mkdirSync(bundleScripts, { recursive: true });
  if (existsSync(join(ROOT, 'scripts'))) {
    await copyRecursive(join(ROOT, 'scripts'), bundleScripts);
  }

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

  // Copy extra root files
  for (const file of EXTRA_FILES) {
    const src = join(ROOT, file);
    if (existsSync(src)) {
      copyFileSync(src, join(bundleDist, file));
    }
  }

  // Create the startup script
  const startScript = `@echo off
title NOVA Download Manager
setlocal enabledelayedexpansion

set NOVA_HOME=%~dp0
set NOVA_ARIA2C=%NOVA_HOME%bin\\aria2c.exe
set NOVA_YTDLP=%NOVA_HOME%bin\\yt-dlp.exe
set VITE_APP_VERSION=${tag}

echo.
echo  ╔══════════════════════════════════════╗
echo  ║       NOVA Download Manager          ║
echo  ║      %tag%                 ║
echo  ╚══════════════════════════════════════╝
echo.

cd /d "%NOVA_HOME%"

if not exist node_modules (
    echo [NOVA] Installing dependencies...
    call npm install --production
)

echo [NOVA] Starting daemon on http://127.0.0.1:3199
start "" /B "cmd /c" npx tsx server/nova-daemon.ts 2^>nul
echo [NOVA] Daemon started.

echo [NOVA] Starting web interface...
start "" http://127.0.0.1:3199
npx vite preview --port 3199 --host 127.0.0.1 --base ./
`;
  writeFileSync(join(bundleDist, 'start.bat'), startScript);

  // Create launcher without prompt
  const launcherScript = `@echo off
set NOVA_HOME=%~dp0
set NOVA_ARIA2C=%NOVA_HOME%bin\\aria2c.exe
set NOVA_YTDLP=%NOVA_HOME%bin\\yt-dlp.exe
set VITE_APP_VERSION=${tag}
cd /d "%NOVA_HOME%"
start /B "" npx tsx server/nova-daemon.ts > nul 2>&1
timeout /t 2 /nobreak > nul
start http://127.0.0.1:3199
npx vite preview --port 3199 --host 127.0.0.1 --base ./
`;
  writeFileSync(join(bundleDist, 'NOVA-Launcher.bat'), launcherScript);

  console.log(`[bundle] ✓ Bundle created at: ${bundleDist}`);
  console.log(`[bundle] ✓ Version: ${tag}`);

  // Print manifest if exists
  if (existsSync(MANIFEST_PATH)) {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    console.log('[bundle] Engine versions:');
    for (const [name, info] of Object.entries(manifest)) {
      console.log(`  - ${name}: ${info.version}`);
    }
  }
}

async function copyRecursive(src, dest) {
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
