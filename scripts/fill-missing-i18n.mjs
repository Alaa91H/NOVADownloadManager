import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { en } from '../src/lib/i18n/en.ts';

const I18N_DIR = join(import.meta.dirname, '..', 'src', 'lib', 'i18n');
const sourceKeys = Object.keys(en);
let updated = 0;

for (const file of readdirSync(I18N_DIR).filter(f => f.endsWith('.ts') && f !== 'en.ts' && f !== 'translations.ts' && f !== 'languageMetadata.ts')) {
  const path = join(I18N_DIR, file);
  let content = readFileSync(path, 'utf8');
  let changed = false;

  for (const key of sourceKeys) {
    const keyPattern = new RegExp(`'${key}':\\s*'`);
    if (!keyPattern.test(content)) {
      const exportMatch = content.match(/export\s+const\s+\w+\s*:\s*Record<string,\s*string>\s*=\s*\{/);
      if (exportMatch) {
        const insertPos = content.indexOf('{', exportMatch.index!) + 1;
        const escaped = en[key].replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        content = content.slice(0, insertPos) + `\n  '${key}': '${escaped}',` + content.slice(insertPos);
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(path, content, 'utf8');
    updated++;
  }
}

console.log(`[i18n:fill] Updated ${updated} file(s) with missing keys from en.ts`);
if (updated > 0) process.exit(0);
