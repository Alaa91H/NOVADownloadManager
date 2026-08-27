import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGE_METADATA } from '../src/lib/i18n/languageMetadata.ts';
import { RESOURCE_KEYS } from './generate-android-locales.mts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RES_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'res');
let failures = 0;

function androidValuesDirectory(language: string): string {
  return language === 'en' ? 'values' : `values-b+${language.replaceAll('-', '+')}`;
}

for (const { value: language } of LANGUAGE_METADATA) {
  const path = join(RES_DIR, androidValuesDirectory(language), 'strings.xml');
  if (!existsSync(path)) {
    failures += 1;
    console.error(`[android:i18n] Missing Android locale resource for ${language}: ${path}`);
    continue;
  }

  const xml = readFileSync(path, 'utf8');
  for (const resourceName of Object.keys(RESOURCE_KEYS)) {
    if (!new RegExp(`<string\\s+name="${resourceName}"(?:\\s|>)`).test(xml)) {
      failures += 1;
      console.error(`[android:i18n] ${language} is missing Android resource ${resourceName}`);
    }
  }
}

if (failures > 0) {
  console.error(`[android:i18n] Failed with ${String(failures)} locale coverage issue(s).`);
  process.exit(1);
}

console.warn(`[android:i18n] ${String(LANGUAGE_METADATA.length)} Android locale resources validated with ${String(Object.keys(RESOURCE_KEYS).length)} visible strings each.`);
