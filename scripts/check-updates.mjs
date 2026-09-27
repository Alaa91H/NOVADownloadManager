#!/usr/bin/env node
/**
 * check-updates.mjs
 * Reports outdated npm and Cargo dependencies.
 * Does NOT update anything — purely informational.
 *
 * Usage: node scripts/check-updates.mjs
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function run(cmd, cwd = ROOT) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return e.stdout ?? '';
  }
}

console.log('=== npm/pnpm Outdated Dependencies ===');
const npmOutdated = run('pnpm outdated');
if (npmOutdated.trim()) {
  console.log(npmOutdated);
} else {
  console.log('All npm dependencies are up to date.');
}

console.log('\n=== Cargo Outdated Dependencies ===');
const cargoInstalled = run('cargo outdated --version');
if (cargoInstalled.toLowerCase().includes('cargo-outdated')) {
  const cargoOutdated = run('cargo outdated --manifest-path src-tauri/Cargo.toml');
  console.log(cargoOutdated || 'All Cargo dependencies are up to date.');
} else {
  console.log('cargo-outdated not installed. Run: cargo install cargo-outdated');
  console.log('Falling back to cargo update --dry-run...');
  const dryRun = run('cargo update --manifest-path src-tauri/Cargo.toml --dry-run');
  console.log(dryRun || 'Nothing to update.');
}

console.log('\n=== Cargo Security Audit ===');
const cargoAuditInstalled = run('cargo audit --version');
if (cargoAuditInstalled.toLowerCase().includes('cargo-audit')) {
  const audit = run('cargo audit --manifest-path src-tauri/Cargo.toml');
  console.log(audit || 'No vulnerabilities found.');
} else {
  console.log('cargo-audit not installed. Run: cargo install cargo-audit');
}
