import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists } from './fs-utils.js';

function isForbiddenPackageOutput(file: string): boolean {
  const lower = file.toLowerCase();
  return /\.(zip|xpi|crx)$/.test(lower) && (lower.includes('source') || lower.includes('sources'));
}

if (await pathExists('.output')) {
  let removed = 0;
  for (const file of await readdir('.output')) {
    if (!isForbiddenPackageOutput(file)) continue;
    await rm(join('.output', file), { force: true });
    removed += 1;
  }
  console.log(`Pruned ${removed} source package output(s).`);
}
