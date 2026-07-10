import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'dist',
  'bundle',
  'coverage',
  'playwright-report',
  'test-results',
  '.cache',
  'release',
  'bin',
  'browser-extension/dist',
  'browser-extension/.output',
  'browser-extension/.wxt',
  'browser-extension/coverage',
  'browser-extension/playwright-report',
  'browser-extension/test-results',
  'browser-extension/.cache',
  'src-tauri/target/release/bundle',
  'src-tauri/resources/bin',
  'src-tauri/resources/native-curl-manifest.json',
  'src-tauri/resources/native-curl.env',
  'artifacts',
  'release-notes',
  'src-tauri/target/.rustc_info.json',
  'src-tauri/target/debug',
  'browser-extension/__pycache__',
  'browser-extension/.pytest_cache',
];

const safetyDenyList = new Set(['', '.', '/', ROOT, path.parse(ROOT).root]);

for (const relativeTarget of targets) {
  const absoluteTarget = path.resolve(ROOT, relativeTarget);
  if (safetyDenyList.has(absoluteTarget) || !absoluteTarget.startsWith(ROOT + path.sep)) {
    throw new Error(`Refusing to remove unsafe path: ${absoluteTarget}`);
  }
  await fs.rm(absoluteTarget, { recursive: true, force: true });
}

console.log(`Cleaned ${targets.length} generated paths safely.`);
