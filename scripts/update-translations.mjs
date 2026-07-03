import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { en } from '../src/lib/i18n/en.ts';
import { LANGUAGES } from './i18n-catalog.mjs';

const ROOT = resolve(process.cwd());
const I18N_DIR = join(ROOT, 'src', 'lib', 'i18n');
const CACHE_DIR = join(ROOT, '.cache');
const CACHE_PATH = join(CACHE_DIR, 'i18n-translations.json');
const MAX_CHUNK_CHARS = 4200;
const TRANSLATE_TIMEOUT_MS = 12000;
const TOKEN_PREFIX = 'NOVA_I18N_';
const TOKEN_ARTIFACT_PATTERN = /(NOVA[_\s-]*I18N|НОВА[_\s-]*И18Н|نوفا[_\s-]*I18N|I18N[_\s-]*\d{3}\|?)/i;
const TOKEN_LINE_PATTERN = /^.*?(\d{3})\s*\|\s*(.*)$/u;

const selected = readSelectedLanguages();
const selectedCodes = new Set(selected.map(lang => lang.code));
const isPartialRun = selected.length !== LANGUAGES.length;
const resume = process.argv.includes('--resume');
const entries = Object.entries(en);
const translationCache = loadCache();

function loadCache() {
  try {
    return existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
  } catch {
    return {};
  }
}

function saveCache() {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(translationCache, null, 2), 'utf8');
}

function cacheKey(lang, text) {
  return `${lang.google}:${createHash('sha256').update(text).digest('hex')}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function translateBatch(text, lang) {
  const key = cacheKey(lang, text);
  if (translationCache[key]) return translationCache[key];

  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'en');
  url.searchParams.set('tl', lang.google);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'NOVA-i18n-builder/1.0' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      const translated = Array.isArray(payload?.[0])
        ? payload[0].map(part => part?.[0] || '').join('')
        : '';
      if (!translated) {
        throw new Error('Empty translation response');
      }
      translationCache[key] = translated;
      saveCache();
      await delay(120);
      return translated;
    } catch (error) {
      lastError = error;
      await delay(800 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('Translation request failed');
}

function readSelectedLanguages() {
  const arg = process.argv.find(item => item.startsWith('--languages='));
  if (!arg) return LANGUAGES;
  const wanted = new Set(arg.slice('--languages='.length).split(',').map(item => item.trim()).filter(Boolean));
  return LANGUAGES.filter(lang => wanted.has(lang.code));
}

function exportName(code) {
  return code.replace(/[^a-zA-Z0-9]+(.)?/g, (_, next = '') => next.toUpperCase()).replace(/^(\d)/, '_$1');
}

function fileStem(code) {
  return code.replace(/[^a-zA-Z0-9]+/g, '_');
}

function escapeTs(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n');
}

function maskPlaceholders(value) {
  const names = [];
  const text = value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
    const index = names.push(name) - 1;
    return `[[${index}]]`;
  });
  return { text, names };
}

function unmaskPlaceholders(value, names) {
  return value.replace(/\[\[(\d+)\]\]/g, (_, index) => `{${names[Number(index)] ?? index}}`);
}

function placeholders(value) {
  return [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(match => match[1]).sort();
}

function isUsableTranslation(sourceValue, translatedValue) {
  if (!translatedValue) return false;
  if (TOKEN_ARTIFACT_PATTERN.test(translatedValue)) return false;
  return placeholders(sourceValue).join(',') === placeholders(translatedValue).join(',');
}

function parseTokenLine(line) {
  const match = line.match(TOKEN_LINE_PATTERN);
  if (!match) return null;
  return { index: Number(match[1]), value: match[2].trim() };
}

function chunkEntries(items) {
  const chunks = [];
  let current = [];
  let size = 0;

  for (const item of items) {
    const lineSize = item[0].length + item[1].length + 32;
    if (current.length > 0 && size + lineSize > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += lineSize;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function translateLanguage(lang) {
  if (lang.code === 'en') {
    return Object.fromEntries(entries);
  }

  const result = {};
  const chunks = chunkEntries(entries.filter(([, value]) => value !== ''));
  for (const chunk of chunks) {
    const prepared = chunk.map(([key, value], index) => {
      const masked = maskPlaceholders(value);
      return { key, value, index, ...masked };
    });
    const input = prepared
      .map(item => `${TOKEN_PREFIX}${String(item.index).padStart(3, '0')}|${item.text}`)
      .join('\n');

    let translated = '';
    try {
      translated = await translateBatch(input, lang);
    } catch (error) {
      process.stdout.write(`batch fallback (${error.message}); `);
    }
    const lines = translated.split(/\r?\n/);
    const mapped = new Map();

    for (const line of lines) {
      const parsed = parseTokenLine(line);
      if (parsed) {
        mapped.set(parsed.index, parsed.value);
      }
    }

    for (let i = 0; i < chunk.length; i += 1) {
      const [key, sourceValue] = chunk[i];
      let translatedValue = mapped.has(i) ? unmaskPlaceholders(mapped.get(i), prepared[i].names) : '';
      if (!isUsableTranslation(sourceValue, translatedValue)) {
        try {
          translatedValue = await translatePreparedItem(prepared[i], lang);
        } catch (error) {
          process.stdout.write(`fallback ${key} (${error.message}); `);
          translatedValue = sourceValue;
        }
      }
      if (!isUsableTranslation(sourceValue, translatedValue)) {
        translatedValue = sourceValue;
        process.stdout.write(`fallback ${key}; `);
      }
      result[key] = translatedValue;
    }
  }

  for (const [key, value] of entries) {
    if (value === '') result[key] = '';
  }

  return result;
}

async function translatePreparedItem(item, lang) {
  const input = `${TOKEN_PREFIX}000|${item.text}`;
  const translated = await translateBatch(input, lang);
  for (const line of translated.split(/\r?\n/)) {
    const parsed = parseTokenLine(line);
    if (parsed?.index === 0) {
      const value = unmaskPlaceholders(parsed.value, item.names);
      if (value) return value;
    }
  }
  const taggedValue = unmaskPlaceholders(translated.replace(/^.*?000\|?/u, '').trim(), item.names);
  if (taggedValue) return taggedValue;
  const direct = await translateBatch(item.text, lang);
  return unmaskPlaceholders(direct.trim(), item.names);
}

function writeLanguageFile(lang, values, targetDir = I18N_DIR) {
  const name = exportName(lang.code);
  const lines = [`export const ${name}: Record<string, string> = {`];
  for (const [key] of entries) {
    lines.push(`  '${escapeTs(key)}': '${escapeTs(values[key] ?? en[key])}',`);
  }
  lines.push('};', '');
  writeFileSync(join(targetDir, `${fileStem(lang.code)}.ts`), lines.join('\n'), 'utf8');
}

function writeMetadata(targetDir = I18N_DIR) {
  const lines = [
    "import type { Language } from './translations';",
    '',
    'export const LANGUAGE_METADATA: Array<{ value: Language; label: string; subLabel: string }> = ['
  ];
  for (const lang of LANGUAGES) {
    lines.push(`  { value: '${escapeTs(lang.code)}' as Language, label: '${escapeTs(lang.label)}', subLabel: '${escapeTs(lang.label)}' },`);
  }
  lines.push('];', '');
  writeFileSync(join(targetDir, 'languageMetadata.ts'), lines.join('\n'), 'utf8');
}

function writeTranslationsIndex(targetDir = I18N_DIR) {
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

async function main() {
  mkdirSync(I18N_DIR, { recursive: true });
  const outputDir = isPartialRun ? I18N_DIR : join(CACHE_DIR, 'i18n-staging');
  if (!isPartialRun) {
    if (!resume) {
      rmSync(outputDir, { recursive: true, force: true });
    }
    mkdirSync(outputDir, { recursive: true });
  }

  if (isPartialRun && existsSync(I18N_DIR)) {
    for (const lang of LANGUAGES.filter(item => selectedCodes.has(item.code))) {
      rmSync(join(I18N_DIR, `${fileStem(lang.code)}.ts`), { force: true });
    }
  }

  for (const lang of selected) {
    const stagedPath = join(outputDir, `${fileStem(lang.code)}.ts`);
    if (!isPartialRun && resume && existsSync(stagedPath)) {
      process.stdout.write(`[i18n] ${lang.code.padEnd(8)} ${lang.label}... cached\n`);
      continue;
    }
    process.stdout.write(`[i18n] ${lang.code.padEnd(8)} ${lang.label}... `);
    const values = await translateLanguage(lang);
    writeLanguageFile(lang, values, outputDir);
    process.stdout.write('done\n');
  }

  if (!isPartialRun) {
    for (const lang of LANGUAGES) {
      const file = join(outputDir, `${fileStem(lang.code)}.ts`);
      if (!existsSync(file)) {
        throw new Error(`Missing generated file for ${lang.code}. Run without --languages to rebuild the full catalog.`);
      }
    }

    writeMetadata(outputDir);
    writeTranslationsIndex(outputDir);
    writeLanguagesFacade();
    for (const file of readdirSync(I18N_DIR).filter(name => name.endsWith('.ts'))) {
      rmSync(join(I18N_DIR, file), { force: true });
    }
    for (const file of readdirSync(outputDir).filter(name => name.endsWith('.ts'))) {
      copyFileSync(join(outputDir, file), join(I18N_DIR, file));
    }
    console.log(`[i18n] Generated ${LANGUAGES.length} language files with ${entries.length} keys each.`);
  } else {
    console.log(`[i18n] Generated ${selected.length} selected language file(s). Run without --languages to rebuild indexes.`);
  }
}

main().catch(error => {
  console.error(error.stack || `[i18n] ${error.message}`);
  process.exit(1);
});
