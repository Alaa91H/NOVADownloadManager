#!/usr/bin/env node
/**
 * Repair Unicode replacement-character mojibake in browser-extension locale
 * files. The corruption pattern is a lost UTF-8 prefix followed by a
 * surviving ASCII character. Each mapping key below uses a Unicode escape for
 * the replacement character plus the surviving bytes, so this source remains
 * clean while continuing to detect and repair corrupted locale input.
 *
 * Latin-script locales are repaired with a per-language mapping table.
 * Non-Latin scripts (bn, fa, th) collapsed beyond recovery and must be
 * re-translated — this tool refuses to touch them.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LOCALE_DIR = 'src/i18n/locales';

// Per-language replacement maps. Keys contain an escaped replacement
// character plus following chars; values are the correct string. Longer keys
// must precede their prefixes, so ordering matters.
const MAPS = {
  // German: ß, Ö, Ü, …, —
  de: {
    '…\uFFFD': '…', // removes a leftover escaped replacement-character suffix
    '\uFFFDY': 'ß',
    '\uFFFD?': '…',
    '\uFFFD-ffnen': 'Öffnen',
    '\uFFFDobergabe': 'Übergabe',
    '\uFFFDober': 'Über',
    '\uFFFD"': '—',
  },
  // Swedish: Ö, Å, …
  sv: {
    '…\uFFFD': '…',
    '\uFFFD-': 'Ö',
    '\uFFFD.': 'Å', // replacement-character prefix in a Swedish word
    '\uFFFD?': '…',
  },
  // Romanian: ă, ș, ț, Î, Ș, …
  ro: {
    '…\uFFFD': '…',
    '\uFFFDZn': 'În', // replacement-character prefix in a Romanian word
    '\uFFFD~': 'Ș', // replacement-character prefix in a Romanian word
    '\uFFFDf': 'ă',
    '\uFFFDc': 'ț', // replacement-character prefix in a Romanian word
    '\uFFFD>': 'ș',
    '\uFFFDT': 'ș', // replacement-character prefix in a Romanian word
    '\uFFFDF': 'Ă',
    '\uFFFD?': '…',
  },
  // Turkish: ğ, ş, …, ö, ı, Ş
  tr: {
    '…\uFFFD': '…',
    '\uFFFD-': 'Ö', // replacement-character prefix in a Turkish word
    '\uFFFDz': 'Şi', // replacement-character prefix in a Turkish word
    '\uFFFDe': 'Ş',
    '\uFFFDY': 'ğ',
    '\uFFFD?': '…',
    '\uFFFDo': 'ş',
    '\uFFFD"': 'ö',
    '\uFFFD>': 'ş',
    '\uFFFDi': 'ı',
  },
  // Spanish: …, ú
  es: {
    '…\uFFFD': '…',
    '\uFFFDs': 'ús', // replacement-character prefix in Spanish words
    '\uFFFD?': '…',
  },
  // French: …, É/é/œ
  fr: {
    '…\uFFFD': '…',
    '\uFFFD?t': 'Ét',
    '\uFFFD?c': 'Éc',
    '\uFFFD?': '…',
    '\uFFFDe': 'é',
    '\uFFFDc': 'œ',
  },
  // Italian: …, —
  it: {
    '…\uFFFD': '…',
    '\uFFFD?': '…',
    '\uFFFD"': '—',
  },
  // Dutch: …, —
  nl: {
    '…\uFFFD': '…',
    '\uFFFD?': '…',
    '\uFFFD"': '—',
  },
  // Portuguese: …, ú, ã/õ/ç
  pt: {
    '…\uFFFD': '…',
    '\uFFFDs': 'ús', // replacement-character prefix in Spanish words
    '\uFFFD?': '…',
    '\uFFFDa': 'ã',
    '\uFFFDo': 'õ',
    '\uFFFDc': 'ç',
  },
  // Indonesian: …
  id: {
    '…\uFFFD': '…',
    '\uFFFD?': '…',
  },
};

// Locales that collapsed beyond recovery (script lost) — need re-translation.
const NON_LATIN = new Set(['bn', 'fa', 'th']);

function countFffd(text) {
  return (text.match(/\uFFFD/g) || []).length;
}

function repairFile(lang, file) {
  const path = join(LOCALE_DIR, file);
  const original = readFileSync(path, 'utf8');
  const map = MAPS[lang];
  if (!map) {
    console.warn(`[fix-locale] ${file}: no mapping for language "${lang}" — skipped`);
    return;
  }
  let repaired = original;
  for (const [from, to] of Object.entries(map)) {
    repaired = repaired.split(from).join(to);
  }
  const before = countFffd(original);
  const after = countFffd(repaired);
  writeFileSync(path, repaired, 'utf8');
  console.log(
    `[fix-locale] ${file}: U+FFFD ${before} -> ${after}${after === 0 ? ' ✅' : ' ⚠️  remaining'}`,
  );
}

function main() {
  if (!existsSync(LOCALE_DIR)) {
    console.error(`[fix-locale] missing ${LOCALE_DIR}`);
    process.exit(1);
  }
  const files = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.ts'));
  let fixed = 0;
  let remaining = 0;
  for (const file of files) {
    const lang = file.replace(/\.ts$/, '');
    if (NON_LATIN.has(lang)) {
      const body = readFileSync(join(LOCALE_DIR, file), 'utf8');
      const n = countFffd(body);
      if (n > 0) {
        console.warn(`[fix-locale] ${file}: non-Latin script, ${n} U+FFFD — requires re-translation`);
        remaining += n;
      }
      continue;
    }
    const before = countFffd(readFileSync(join(LOCALE_DIR, file), 'utf8'));
    if (before === 0) continue;
    repairFile(lang, file);
    fixed += 1;
  }
  console.log(`[fix-locale] fixed ${fixed} files; ${remaining} U+FFFD remain in non-Latin locales.`);
  if (remaining > 0) {
    console.error('[fix-locale] non-Latin locales (bn, fa, th) still need manual re-translation.');
  }
}

main();
