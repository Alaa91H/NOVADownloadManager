import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { en } from '../src/lib/i18n/en.ts';
import { loadDict } from './i18n-dicts.mjs';

const I18N_DIR = join(import.meta.dirname, '..', 'src', 'lib', 'i18n');
const sourceKeys = Object.keys(en);
const sourceEntries = Object.entries(en);

function exportName(code) {
  return code.replace(/[^a-zA-Z0-9]+(.)?/g, (_, next = '') => next.toUpperCase()).replace(/^(\d)/, '_$1');
}

function escapeTs(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n');
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(match => match[1]).sort();
}

const tokenArtifactPattern = /(NOVA[_\s-]*I18N|НОВА[_\s-]*И18Н|نوفا[_\s-]*I18N|I18N[_\s-]*\d{3}\|?)/i;
const invalidEncodingPattern = /�/;

let totalFixed = 0;

function fixValue(key, value) {
  const sourceValue = en[key];
  if (sourceValue === undefined) return value; // unknown key, will be dropped

  // Fix placeholder mismatches
  const sourcePh = placeholders(sourceValue).join(',');
  const valuePh = placeholders(value).join(',');
  if (sourcePh !== valuePh) {
    // Use English value as fallback if placeholders don't match
    totalFixed++;
    return sourceValue;
  }

  // Fix invalid replacement characters
  if (invalidEncodingPattern.test(value)) {
    totalFixed++;
    return sourceValue;
  }

  // Fix internal translation tokens
  if (tokenArtifactPattern.test(value)) {
    totalFixed++;
    return sourceValue;
  }

  return value;
}

const files = readdirSync(I18N_DIR).filter(
  name => name.endsWith('.ts') && name !== 'en.ts' && name !== 'translations.ts'
    && name !== 'languageMetadata.ts' && !name.startsWith('__')
);

for (const file of files) {
  const code = file.slice(0, -3); // remove .ts
  const dict = await loadDict(code);
  if (!dict) {
    console.error(`[fix] Could not load ${code}, skipping`);
    continue;
  }

  const oldKeys = Object.keys(dict);
  const newDict = {};

  // Keep all existing keys that match English keys, with fixes applied
  for (const [key, value] of Object.entries(dict)) {
    if (key in en) {
      newDict[key] = fixValue(key, value);
    } else {
      totalFixed++;
      console.log(`[fix] ${code}: removing unknown key ${key}`);
    }
  }

  // Add any missing keys from English
  for (const [key, value] of sourceEntries) {
    if (!(key in newDict)) {
      newDict[key] = value;
      totalFixed++;
    }
  }

  // Write the file preserving the same format
  const name = exportName(code);
  const lines = [`export const ${name}: Record<string, string> = {`];
  for (const [key] of sourceEntries) {
    lines.push(`  '${escapeTs(key)}': '${escapeTs(newDict[key] ?? en[key])}',`);
  }
  lines.push('};', '');

  writeFileSync(join(I18N_DIR, file), lines.join('\n'), 'utf8');
  console.log(`[fix] ${code}: ${oldKeys.length} -> ${sourceKeys.length} keys`);
}

console.log(`[fix] Fixed ${totalFixed} issue(s) across ${files.length} languages.`);
