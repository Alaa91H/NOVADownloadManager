// One-off: add the rename/re-download context-menu keys to every language
// dictionary that is missing them. English values are used as the fallback
// (matching the project convention: untranslated keys fall back to English).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const I18N_DIR = join(import.meta.dirname, '..', 'src', 'lib', 'i18n');

// Key -> English fallback value (single-quoted TS string literal content).
const entries = [
  ['action_rename', 'Rename Download'],
  ['menu_rename', 'Rename'],
  ['menu_redownload', 'Re-download'],
  ['rename_title', 'Rename download'],
  ['rename_desc', 'Enter a new file name for this download. If the file already exists on disk, it will be renamed too (the original extension is kept when omitted).'],
  ['rename_new_name', 'New name'],
  ['rename_btn', 'Rename'],
  ['rename_invalid_chars', 'The name contains characters that are not allowed: / \\ : * ? " < > |'],
  ['redownload_confirm', 'Re-download "{name}" from the beginning? The existing file will be replaced.'],
];

const skip = new Set(['en.ts', 'ar.ts', 'translations.ts', 'languageMetadata.ts']);
const files = readdirSync(I18N_DIR).filter(f => f.endsWith('.ts') && !skip.has(f));

function escapeValue(v) {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

let updated = 0;
for (const file of files) {
  const filePath = join(I18N_DIR, file);
  let content = readFileSync(filePath, 'utf8');
  let changed = false;
  for (const [key, value] of entries) {
    if (!content.includes(`'${key}':`) && !content.includes(`  ${key}:`)) {
      const line = `  '${key}': '${escapeValue(value)}',\n`;
      content = content.replace(/\n};\s*$/, `\n${line}};\n`);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(filePath, content, 'utf8');
    updated++;
  }
}
console.log(`Updated ${updated} files with rename/re-download keys`);
