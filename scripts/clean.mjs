import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['dist', 'bundle', '.cache', 'bin'];

for (const target of targets) {
  try {
    await fs.rm(path.resolve(ROOT, target), { recursive: true, force: true });
  } catch {
    // skip if already removed or missing
  }
}
