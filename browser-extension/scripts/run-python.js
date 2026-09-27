#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/run-python.js <script.py> [...args]');
  process.exit(2);
}

const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
let lastError = '';
for (const command of candidates) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (!result.error) process.exit(result.status ?? 0);
  lastError = result.error.message;
}
console.error(`Could not locate Python runtime. Last error: ${lastError}`);
process.exit(1);
