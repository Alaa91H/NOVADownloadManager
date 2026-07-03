import { en } from '../src/lib/i18n/en.ts';
import { translations } from '../src/lib/i18n/translations.ts';

const PRIMARY_LANGUAGE_CODES = [
  'en',
  'ar',
  'fr',
  'es',
  'de',
  'pt',
  'ru',
  'zh',
  'zh-TW',
  'hi',
  'bn',
  'ur',
  'id',
  'ja',
  'ko',
  'tr',
  'fa',
  'vi',
  'it',
  'nl',
];

const sourceEntries = Object.entries(en);
const tokenArtifactPattern = /(NOVA[_\s-]*I18N|I18N[_\s-]*\d{3}\|?)/i;
const replacementCharacterPattern = /\uFFFD/;
let failures = 0;

function placeholders(value) {
  return [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort().join(',');
}

function fail(message) {
  failures += 1;
  console.error(`[i18n:primary] ${message}`);
}

for (const code of PRIMARY_LANGUAGE_CODES) {
  const dict = translations[code];
  if (!dict) {
    fail(`${code} dictionary is missing`);
    continue;
  }

  for (const [key, source] of sourceEntries) {
    const value = dict[key];
    if (typeof value !== 'string') {
      fail(`${code}:${key} is missing`);
      continue;
    }
    if (placeholders(source) !== placeholders(value)) {
      fail(`${code}:${key} has placeholder mismatch`);
    }
    if (replacementCharacterPattern.test(value) || tokenArtifactPattern.test(value)) {
      fail(`${code}:${key} contains an invalid generated artifact`);
    }
  }
}

if (failures > 0) {
  console.error(`[i18n:primary] Failed with ${failures} issue(s).`);
  process.exit(1);
}

console.log(`[i18n:primary] ${PRIMARY_LANGUAGE_CODES.length} primary languages validated with ${sourceEntries.length} keys each.`);
