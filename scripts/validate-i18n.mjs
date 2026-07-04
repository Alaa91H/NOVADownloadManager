import { en } from '../src/lib/i18n/en.ts';
import { LANGUAGE_METADATA } from '../src/lib/i18n/languageMetadata.ts';
import { loadDict } from './i18n-dicts.mjs';

const sourceKeys = Object.keys(en);
const sourceKeySet = new Set(sourceKeys);
const sourcePlaceholders = new Map(sourceKeys.map(key => [key, placeholders(en[key]).join(',')]));
const tokenArtifactPattern = /(NOVA[_\s-]*I18N|НОВА[_\s-]*И18Н|نوفا[_\s-]*I18N|I18N[_\s-]*\d{3}\|?)/i;
const invalidEncodingPattern = /�/;

let failures = 0;

function placeholders(value) {
  return [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(match => match[1]).sort();
}

function fail(message) {
  failures += 1;
  console.error(`[i18n:validate] ${message}`);
}

for (const { value } of LANGUAGE_METADATA) {
  const dict = await loadDict(value);
  if (!dict) {
    fail(`Missing translation dictionary for ${value}`);
    continue;
  }

  for (const key of sourceKeys) {
    if (!(key in dict)) {
      fail(`${value} is missing key ${key}`);
      continue;
    }

    const text = String(dict[key]);
    if (sourcePlaceholders.get(key) !== placeholders(text).join(',')) {
      fail(`${value}:${key} has placeholder mismatch`);
    }

    if (invalidEncodingPattern.test(text)) {
      fail(`${value}:${key} contains an invalid replacement character`);
    }

    if (tokenArtifactPattern.test(text)) {
      fail(`${value}:${key} contains an internal translation token`);
    }
  }

  for (const key of Object.keys(dict)) {
    if (!sourceKeySet.has(key)) {
      fail(`${value} has unknown key ${key}`);
    }
  }
}

if (failures > 0) {
  console.error(`[i18n:validate] Failed with ${failures} issue(s).`);
  process.exit(1);
}

console.log(`[i18n:validate] ${LANGUAGE_METADATA.length} languages validated with ${sourceKeys.length} keys each.`);
