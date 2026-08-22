import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LANGUAGES } from './i18n-catalog.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const read = (relativePath) => readFileSync(resolve(ROOT, relativePath), 'utf8');
const failures = [];

function requireContains(relativePath, expected, label) {
  if (!read(relativePath).includes(expected)) {
    failures.push(`${label}: expected ${relativePath} to contain ${JSON.stringify(expected)}`);
  }
}

function requireNotContains(relativePath, stale, label) {
  if (read(relativePath).includes(stale)) {
    failures.push(`${label}: ${relativePath} must not contain ${JSON.stringify(stale)}`);
  }
}

const languageCount = LANGUAGES.length;
const readme = 'README.md';

requireContains(readme, `**${languageCount} interface languages**`, 'README language claim');
requireContains(readme, `(${languageCount} languages, 6 themes)`, 'README source-tree language claim');
requireContains(readme, `${languageCount} languages, loaded on demand`, 'README performance language claim');
requireNotContains(readme, '35 supported interface languages', 'stale README language claim');
requireNotContains(readme, 'Desktop React interface (35 languages', 'stale README source-tree language claim');
requireNotContains(readme, 'translation chunks (35 languages', 'stale README performance language claim');

requireContains('src-tauri/Cargo.toml', 'panic = "unwind"', 'Cargo release panic strategy');
requireContains('src-tauri/Cargo.toml', 'overflow-checks = true', 'Cargo release overflow setting');
requireContains(readme, 'panic = "unwind"', 'README release panic strategy');
requireContains(readme, 'overflow-checks = true', 'README release overflow setting');
requireNotContains(readme, 'panic = "abort"', 'stale README panic strategy');
requireNotContains(readme, 'overflow-checks = false', 'stale README overflow setting');

if (failures.length > 0) {
  console.error('[facts:verify] Project documentation facts are inconsistent:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[facts:verify] README matches ${languageCount} catalog languages and the Rust release profile.`);
