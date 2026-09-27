#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync('pnpm', ['tsx', 'tools/release-checks.ts', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
