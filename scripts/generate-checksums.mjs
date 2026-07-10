#!/usr/bin/env node
// Generates SHA-256 checksums for all files in the release directory.
// Usage: node scripts/generate-checksums.mjs [releaseDir]

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = resolve(ROOT, process.argv[2] || 'release');

function sha256(filePath) {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const files = readdirSync(releaseDir)
  .filter((name) => name !== 'SHA256SUMS.txt' && name !== 'build-metadata.json')
  .sort();

const lines = [];
lines.push(`# Nova Download Manager SHA-256 Checksums`);
lines.push(`# Generated: ${new Date().toISOString()}`);
lines.push(`# Files: ${files.length}`);
lines.push('');

const summary = [];
for (const file of files) {
  const filePath = join(releaseDir, file);
  const hash = sha256(filePath);
  const { size } = readdirSync(releaseDir).length ? { size: readFileSync(filePath).length } : { size: 0 };
  lines.push(`${hash}  ${file}`);
  summary.push({ name: file, hash: hash.slice(0, 16) + '...', size: formatSize(size) });
}

const checksumPath = join(releaseDir, 'SHA256SUMS.txt');
writeFileSync(checksumPath, lines.join('\n'), 'utf8');
console.log(`[checksums] Wrote ${files.length} checksums to ${checksumPath}`);
for (const s of summary) {
  console.log(`  ${s.hash}  ${s.size.padStart(10)}  ${s.name}`);
}
