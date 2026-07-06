// Shared helper for i18n scripts: loads a language dictionary directly from
// its module file. The generated translations.ts index is lazy (dynamic
// imports only), so tooling reads the per-language files instead.

export function fileStem(code) {
  return code.replace(/[^a-zA-Z0-9]+/g, '_');
}

export async function loadDict(code) {
  try {
    const module = await import(`../src/lib/i18n/${fileStem(code)}.ts`);
    return Object.values(module).find(value => value && typeof value === 'object') ?? null;
  } catch {
    return null;
  }
}
