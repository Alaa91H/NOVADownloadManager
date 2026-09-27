import { rm } from 'node:fs/promises';

for (const path of ['.output', 'dist', 'coverage', 'test-results', 'playwright-report']) {
  await rm(path, { recursive: true, force: true });
}

console.log('Cleaned generated build/test artifacts.');
