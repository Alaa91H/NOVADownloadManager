import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { en } from '../src/lib/i18n/en.ts';
import { LANGUAGES } from './i18n-catalog.mjs';

const ROOT = resolve(process.cwd());
const I18N_DIR = join(ROOT, 'src', 'lib', 'i18n');
const STAGING_DIR = join(ROOT, '.cache', 'i18n-staging');
const entries = Object.entries(en);

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
  writeFileSync(join(targetDir, `${fileStem(lang.code)}.ts`), lines.join('\n'), 'utf8');
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
  writeFileSync(join(targetDir, 'languageMetadata.ts'), lines.join('\n'), 'utf8');
}

function writeTranslationsIndex(targetDir) {
  const imports = [];
  const languageUnion = [];
  const mapLines = [];

  for (const lang of LANGUAGES) {
    const name = exportName(lang.code);
    imports.push(`import { ${name} } from './${fileStem(lang.code)}';`);
    languageUnion.push(`'${escapeTs(lang.code)}'`);
    mapLines.push(`  '${escapeTs(lang.code)}': ${name},`);
  }

  const lines = [
    ...imports,
    '',
    `export type Language = ${languageUnion.join(' | ')};`,
    '',
    'export const translations: Record<Language, Record<string, string>> = {',
    ...mapLines,
    '};',
    '',
    'export function getTranslation(',
    '  lang: string,',
    '  key: string,',
    '  params?: Record<string, string | number>',
    '): string {',
    "  const code = (lang as Language) || 'en';",
    "  const dict = translations[code] || translations['en'];",
    "  let text = dict[key] || translations['en'][key] || key;",
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
  writeFileSync(join(targetDir, 'translations.ts'), lines.join('\n'), 'utf8');
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
  writeFileSync(join(ROOT, 'src', 'lib', 'languages.ts'), lines.join('\n'), 'utf8');
}

mkdirSync(I18N_DIR, { recursive: true });
for (const file of readdirSync(I18N_DIR).filter(name => name.endsWith('.ts'))) {
  rmSync(join(I18N_DIR, file), { force: true });
}

let translatedCount = 0;
for (const lang of LANGUAGES) {
  const target = join(I18N_DIR, `${fileStem(lang.code)}.ts`);
  const staged = join(STAGING_DIR, `${fileStem(lang.code)}.ts`);
  if (existsSync(staged)) {
    copyFileSync(staged, target);
    translatedCount += 1;
  } else {
    writeEnglishFallback(lang, I18N_DIR);
  }
}

writeMetadata(I18N_DIR);
writeTranslationsIndex(I18N_DIR);
writeLanguagesFacade();

console.log(`[i18n:sync] Synced ${translatedCount}/${LANGUAGES.length} translated files. Missing languages use English fallback until i18n:update -- --resume completes.`);
