import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(ROOT, 'scripts', 'run-tauri-with-native-curl.mjs');
const NSIS_DIR = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const STAGE_DIR = join(ROOT, 'src-tauri', 'target', 'release', 'nova-installer-scopes');
const USER_CONFIG = join(ROOT, 'src-tauri', 'tauri.user.conf.json');
const MACHINE_CONFIG = join(ROOT, 'src-tauri', 'tauri.machine.conf.json');
const passthroughArgs = process.argv.slice(2);

if (process.platform !== 'win32') {
  console.error('[windows-installers] Dual-scope NSIS packaging must run on Windows.');
  process.exit(1);
}

function scopedInstallerName(fileName, scope) {
  // Keep the historical machine-wide setup filename for backward-compatible
  // release URLs and update channels. Only the new non-elevated flavor gets
  // an explicit suffix.
  if (scope === 'machine') return fileName;
  if (/-setup\.exe$/i.test(fileName)) {
    return fileName.replace(/-setup\.exe$/i, `-${scope}-setup.exe`);
  }
  return fileName.replace(/\.exe$/i, `-${scope}.exe`);
}

function runScope(scope, installMode, configPath) {
  rmSync(NSIS_DIR, { recursive: true, force: true });
  mkdirSync(NSIS_DIR, { recursive: true });

  console.log(`[windows-installers] Building ${scope} installer (${installMode})...`);
  const result = spawnSync(
    process.execPath,
    [RUNNER, '--bundles', 'nsis', '--config', configPath, ...passthroughArgs],
    {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    },
  );

  if (result.error) {
    console.error(`[windows-installers] Failed to start ${scope} build: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[windows-installers] ${scope} build failed with exit code ${String(result.status)}.`);
    process.exit(result.status ?? 1);
  }

  const installers = readdirSync(NSIS_DIR)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .sort();

  if (installers.length !== 1) {
    console.error(
      `[windows-installers] Expected exactly one NSIS installer for ${scope}, found ${String(installers.length)}: ${installers.join(', ')}`,
    );
    process.exit(1);
  }

  const sourceName = installers[0];
  const targetName = scopedInstallerName(sourceName, scope);
  copyFileSync(join(NSIS_DIR, sourceName), join(STAGE_DIR, targetName));

  const signature = `${sourceName}.sig`;
  if (existsSync(join(NSIS_DIR, signature))) {
    copyFileSync(join(NSIS_DIR, signature), join(STAGE_DIR, `${targetName}.sig`));
  }

  console.log(`[windows-installers] Staged ${targetName}`);
}

rmSync(STAGE_DIR, { recursive: true, force: true });
mkdirSync(STAGE_DIR, { recursive: true });

runScope('user', 'currentUser', USER_CONFIG);
runScope('machine', 'perMachine', MACHINE_CONFIG);

rmSync(NSIS_DIR, { recursive: true, force: true });
mkdirSync(NSIS_DIR, { recursive: true });

for (const name of readdirSync(STAGE_DIR).sort()) {
  copyFileSync(join(STAGE_DIR, name), join(NSIS_DIR, name));
}

console.log('[windows-installers] Dual-scope NSIS installers are ready:');
for (const name of readdirSync(NSIS_DIR).sort()) {
  console.log(`  - ${basename(name)}`);
}
