import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import prettier from 'prettier';
import { en } from '../src/lib/i18n/en.ts';
import { LANGUAGES } from './i18n-catalog.mjs';
import { loadDict } from './i18n-dicts.mjs';

const ROOT = resolve(process.cwd());
const I18N_DIR = join(ROOT, 'src', 'lib', 'i18n');
const STAGING_DIR = join(ROOT, '.cache', 'i18n-staging');
const entries = Object.entries(en);
const sourceKeys = Object.keys(en);

// Load the project Prettier config once so generated files match committed style.
const prettierOptions = await prettier.resolveConfig(join(ROOT, '.prettierrc'));

async function writeFormatted(filePath, source) {
  const formatted = await prettier.format(source, { ...prettierOptions, filepath: filePath });
  writeFileSync(filePath, formatted, 'utf8');
}

function exportName(code) {
  return code.replace(/[^a-zA-Z0-9]+(.)?/g, (_, next = '') => next.toUpperCase()).replace(/^(\d)/, '_$1');
}

function fileStem(code) {
  return code.replace(/[^a-zA-Z0-9]+/g, '_');
}

function escapeTs(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n');
}

function writeEnglishFallback(lang, targetDir) {
  const name = exportName(lang.code);
  const lines = [
    `export const ${name}: Record<string, string> = {`,
    ...entries.map(([key, value]) => `  '${escapeTs(key)}': '${escapeTs(value)}',`),
    '};',
    ''
  ];
  return writeFormatted(join(targetDir, `${fileStem(lang.code)}.ts`), lines.join('\n'));
}

function writeMetadata(targetDir) {
  const lines = [
    "import type { Language } from './translations';",
    '',
    'export const LANGUAGE_METADATA: Array<{ value: Language; label: string; subLabel: string }> = [',
    ...LANGUAGES.map(lang => `  { value: '${escapeTs(lang.code)}' as Language, label: '${escapeTs(lang.label)}', subLabel: '${escapeTs(lang.label)}' },`),
    '];',
    ''
  ];
  return writeFormatted(join(targetDir, 'languageMetadata.ts'), lines.join('\n'));
}

function writeTranslationsIndex(targetDir) {
  const languageUnion = [];
  const loaderLines = [];

  for (const lang of LANGUAGES) {
    languageUnion.push(`'${escapeTs(lang.code)}'`);
    loaderLines.push(`  '${escapeTs(lang.code)}': () => import('./${fileStem(lang.code)}'),`);
  }

  const lines = [
    "import { en } from './en';",
    '',
    `export type Language = ${languageUnion.join(' | ')};`,
    '',
    '// English ships in the main bundle as the synchronous fallback; every other',
    '// language is loaded on demand as its own chunk to keep startup fast.',
    'const loaders: Record<Language, () => Promise<Record<string, unknown>>> = {',
    ...loaderLines,
    '};',
    '',
    'const cache: Partial<Record<Language, Record<string, string>>> = { en };',
    '',
    'function normalizeLanguage(lang: string): Language {',
    "  return (lang in loaders ? lang : 'en') as Language;",
    '}',
    '',
    'export function isLanguageLoaded(lang: string): boolean {',
    '  return Boolean(cache[normalizeLanguage(lang)]);',
    '}',
    '',
    'export async function loadLanguage(lang: string): Promise<void> {',
    '  const code = normalizeLanguage(lang);',
    '  if (cache[code]) return;',
    '  const module = await loaders[code]();',
    "  const dict = Object.values(module).find(value => value && typeof value === 'object');",
    '  if (dict) cache[code] = dict as Record<string, string>;',
    '}',
    '',
    'export function getTranslation(',
    '  lang: string,',
    '  key: string,',
    '  params?: Record<string, string | number>',
    '): string {',
    '  const dict = cache[normalizeLanguage(lang)] || en;',
    '  let text = dict[key] || en[key] || key;',
    '',
    '  if (params) {',
    '    Object.entries(params).forEach(([k, v]) => {',
    '      text = text.replace(`{${k}}`, String(v));',
    '    });',
    '  }',
    '  return text;',
    '}',
    ''
  ];
  return writeFormatted(join(targetDir, 'translations.ts'), lines.join('\n'));
}

function writeLanguagesFacade() {
  const lines = [
    "import { LANGUAGE_METADATA } from './i18n/languageMetadata';",
    '',
    "export const WORLD_LANGUAGES = [...LANGUAGE_METADATA].sort((a, b) => {",
    "  if (a.value === 'en') return -1;",
    "  if (b.value === 'en') return 1;",
    '  return a.label.localeCompare(b.label);',
    '});',
    ''
  ];
  return writeFormatted(join(ROOT, 'src', 'lib', 'languages.ts'), lines.join('\n'));
}

mkdirSync(I18N_DIR, { recursive: true });

let translatedCount = 0;
let staleStagedCount = 0;
for (const lang of LANGUAGES) {
  const target = join(I18N_DIR, `${fileStem(lang.code)}.ts`);
  const staged = join(STAGING_DIR, `${fileStem(lang.code)}.ts`);
  if (existsSync(staged)) {
    const stagedDict = await loadDict(lang.code, STAGING_DIR);
    const stagedIsCurrent = stagedDict && sourceKeys.every(key => key in stagedDict);
    if (stagedIsCurrent) {
      copyFileSync(staged, target);
      translatedCount += 1;
    } else if (existsSync(target)) {
      staleStagedCount += 1;
      translatedCount += 1;
    } else {
      staleStagedCount += 1;
      await writeEnglishFallback(lang, I18N_DIR);
    }
  } else if (existsSync(target)) {
    // Keep the committed translation when there is no freshly staged copy
    // (CI has no .cache/i18n-staging; wiping here would ship English only).
    translatedCount += 1;
  } else {
    await writeEnglishFallback(lang, I18N_DIR);
  }
}

await writeMetadata(I18N_DIR);
await writeTranslationsIndex(I18N_DIR);
await writeLanguagesFacade();

const staleNote = staleStagedCount > 0 ? ` Ignored ${staleStagedCount} stale staged file(s).` : '';
console.log(`[i18n:sync] Synced ${translatedCount}/${LANGUAGES.length} translated files. Missing languages use English fallback until i18n:update -- --resume completes.${staleNote}`);
