import { copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const files = await readdir('.output').catch(() => [] as string[]);
const chromeZip = files.find((file) => /-chrome-[\d.]+\.zip$/.test(file));

if (!chromeZip) {
  throw new Error('Chrome ZIP not found under .output. Run pnpm package:chrome before pnpm package:edge.');
}

const edgeZip = chromeZip.replace('-chrome-', '-edge-');
await copyFile(join('.output', chromeZip), join('.output', edgeZip));
console.log(`Created Edge-compatible Chromium package: .output/${edgeZip}`);
