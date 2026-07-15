import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const I18N_DIR = join(import.meta.dirname, '..', 'src', 'lib', 'i18n');

const enContent = readFileSync(join(I18N_DIR, 'en.ts'), 'utf8');

const missingKeys = [
  'progress_seg_speed', 'progress_seg_of', 'progress_live_stats',
  'progress_active_connections', 'progress_overall_progress', 'progress_segment_distribution',
  'progress_downloading_from', 'progress_eta', 'progress_peak_speed'
];

const values = {};
for (const key of missingKeys) {
  const re = new RegExp(`  '${key}': '(.*)',`);
  const m = enContent.match(re);
  if (m) values[key] = m[1];
}

const skip = new Set(['en.ts', 'ar.ts', 'translations.ts', 'languageMetadata.ts']);
const files = readdirSync(I18N_DIR).filter(f => f.endsWith('.ts') && !skip.has(f));
let updated = 0;
for (const file of files) {
  const filePath = join(I18N_DIR, file);
  let content = readFileSync(filePath, 'utf8');
  let changed = false;
  for (const key of missingKeys) {
    if (!content.includes(`'${key}':`)) {
      const value = values[key] || key;
      const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const line = `  '${key}': '${escaped}',\n`;
      content = content.replace(/\n};\s*$/, `\n${line}};\n`);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(filePath, content, 'utf8');
    updated++;
  }
}
console.log(`Updated ${updated} files with missing keys`);
