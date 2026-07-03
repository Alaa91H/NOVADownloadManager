import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const ROOT = resolve(process.cwd());
const RESOURCE_DIR = join(ROOT, 'src-tauri', 'resources');
const RESOURCE_BIN_DIR = join(RESOURCE_DIR, 'bin');
const EXTENSION_DIR = join(ROOT, 'browser-extension');
const EXTENSION_DIST_DIR = join(EXTENSION_DIR, 'dist');
const RESOURCE_EXTENSION_DIR = join(RESOURCE_DIR, 'browser-extension');

function run(command, args, label, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    shell: true,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed`);
  }
}

function copyIfExists(source, target) {
  if (existsSync(source)) {
    rmSync(target, { force: true });
    copyFileSync(source, target);
    return true;
  }
  return false;
}

function buildBrowserExtensionIfPresent() {
  if (!existsSync(join(EXTENSION_DIR, 'package.json'))) {
    return false;
  }

  if (!existsSync(join(EXTENSION_DIR, 'node_modules'))) {
    console.log('[tauri-assets] Installing browser extension dependencies...');
    run('pnpm', ['install', '--frozen-lockfile'], 'Browser extension dependency install', EXTENSION_DIR);
  }

  console.log('[tauri-assets] Building browser extension packages...');
  run('pnpm', ['build'], 'Browser extension build', EXTENSION_DIR);
  return existsSync(EXTENSION_DIST_DIR);
}

async function main() {
  mkdirSync(RESOURCE_BIN_DIR, { recursive: true });

  console.log('[tauri-assets] Building frontend...');
  run('npx', ['vite', 'build'], 'Vite build');

  console.log('[tauri-assets] Bundling local daemon...');
  await build({
    entryPoints: [join(ROOT, 'server', 'nova-daemon.ts')],
    outfile: join(RESOURCE_DIR, 'nova-daemon.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'info'
  });

  console.log('[tauri-assets] Copying runtime and download engines...');
  const nodeTarget = join(RESOURCE_DIR, process.platform === 'win32' ? 'node.exe' : 'node');
  rmSync(nodeTarget, { force: true });
  copyFileSync(process.execPath, nodeTarget);
  copyIfExists(join(ROOT, 'bin', 'aria2c.exe'), join(RESOURCE_BIN_DIR, 'aria2c.exe'));
  copyIfExists(join(ROOT, 'bin', 'yt-dlp.exe'), join(RESOURCE_BIN_DIR, 'yt-dlp.exe'));

  const hasBrowserExtension = buildBrowserExtensionIfPresent();
  if (hasBrowserExtension) {
    console.log('[tauri-assets] Copying browser extension packages...');
    rmSync(RESOURCE_EXTENSION_DIR, { recursive: true, force: true });
    cpSync(EXTENSION_DIST_DIR, RESOURCE_EXTENSION_DIR, { recursive: true });
  }

  const manifest = {
    builtAt: new Date().toISOString(),
    version: process.env.VITE_APP_VERSION || process.env.BUILD_TAG || process.env.GITHUB_REF_NAME || '0.1.0',
    runtime: process.version,
    files: {
      node: process.platform === 'win32' ? 'node.exe' : 'node',
      daemon: 'nova-daemon.cjs',
      directEngine: existsSync(join(RESOURCE_BIN_DIR, 'aria2c.exe')),
      mediaEngine: existsSync(join(RESOURCE_BIN_DIR, 'yt-dlp.exe')),
      browserExtension: hasBrowserExtension ? 'browser-extension' : null,
      browserExtensionBuilds: hasBrowserExtension ? {
        chromium: existsSync(join(RESOURCE_EXTENSION_DIR, 'chromium', 'manifest.json')),
        edge: existsSync(join(RESOURCE_EXTENSION_DIR, 'edge', 'manifest.json')),
        firefox: existsSync(join(RESOURCE_EXTENSION_DIR, 'firefox', 'manifest.json')),
        packages: existsSync(join(RESOURCE_EXTENSION_DIR, 'packages'))
      } : null
    }
  };
  writeFileSync(join(RESOURCE_DIR, 'resource-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log('[tauri-assets] Ready.');
}

main().catch(error => {
  console.error(`[tauri-assets] ${error.message}`);
  process.exit(1);
});
