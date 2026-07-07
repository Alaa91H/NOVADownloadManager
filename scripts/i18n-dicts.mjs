// Shared helper for i18n scripts: loads a language dictionary directly from
// its module file. The generated translations.ts index is lazy (dynamic
// imports only), so tooling reads the per-language files instead.
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function fileStem(code) {
  return code.replace(/[^a-zA-Z0-9]+/g, '_');
}

export async function loadDict(code, baseDir = '../src/lib/i18n') {
  try {
    const specifier = isAbsolute(baseDir)
      ? pathToFileURL(join(baseDir, `${fileStem(code)}.ts`)).href
      : `${baseDir}/${fileStem(code)}.ts`;
    const module = await import(specifier);
    return Object.values(module).find(value => value && typeof value === 'object') ?? null;
  } catch {
    return null;
  }
}
