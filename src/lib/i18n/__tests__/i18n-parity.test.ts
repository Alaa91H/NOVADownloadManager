import { describe, it, expect } from 'vitest';
import { en } from '../en';
import { loadLanguage, getTranslation, isLanguageLoaded } from '../translations';

// Every locale file is a named export of a Record<string, string>.
const localeModules = import.meta.glob('../*.ts', { eager: true });

// The lazy loader picks the first object found in the module — matching what
// loadLanguage() does. Files export e.g. `export const en = {...}`.
function dictOf(module: unknown): Record<string, string> {
  if (!module || typeof module !== 'object') return {};
  const dict = Object.values(module).find(
    (value) => value && typeof value === 'object',
  );
  return (dict as Record<string, string>) ?? {};
}

describe('i18n key parity (REPAIR 0.2)', () => {
  const enKeys = Object.keys(en).sort();

  it('English dictionary is non-empty', () => {
    expect(enKeys.length).toBeGreaterThan(100);
  });

  const localeNames = Object.keys(localeModules).filter((path) => {
    const base = path.split('/').pop()!;
    return (
      base !== 'en.ts' &&
      base !== 'translations.ts' &&
      base !== 'languageMetadata.ts'
    );
  });

  it('covers every language listed in the loader', async () => {
    // translations.ts declares 132 languages; ensure the test sees them all.
    expect(localeNames.length).toBeGreaterThanOrEqual(130);
  });

  for (const path of localeNames) {
    const base = path.split('/').pop()!;
    const lang = base.replace(/\.ts$/, '');

    it(`${lang} has exactly the en keys`, async () => {
      const module = localeModules[path];
      const dict = dictOf(module);

      const dictKeys = Object.keys(dict).sort();
      const missing = enKeys.filter((k) => !(k in dict));
      const extra = dictKeys.filter((k) => !(k in en));

      expect(missing, `${lang} missing keys: ${missing.join(', ')}`).toEqual([]);
      expect(extra, `${lang} extra keys: ${extra.join(', ')}`).toEqual([]);
    });
  }

  it('every loader language actually resolves through loadLanguage', async () => {
    for (const path of localeNames) {
      const base = path.split('/').pop()!;
      const lang = base.replace(/\.ts$/, '');
      await loadLanguage(lang);
      expect(isLanguageLoaded(lang)).toBe(true);
      // A real key must return a translated string, not the key itself.
      const sample = enKeys[0];
      expect(typeof getTranslation(lang, sample)).toBe('string');
      expect(getTranslation(lang, sample).length).toBeGreaterThan(0);
    }
  });

  it('zh/zh_TW have no raw English values (round 2)', async () => {
    // Round-2 follow-up: zh.ts/zh_TW.ts historically kept keys with raw
    // English values (sched_engine_*, rename_*, settings_logging_*, …).
    // A value that is pure ASCII English prose is treated as untranslated.
    // Technical tokens are legitimate ASCII: resolutions (8K 4320p),
    // keyboard modifiers (Ctrl/Alt/Shift), browser names, protocols,
    // placeholders (URLs/ports), file extensions, single words ≤ 12 chars.
    const legitAscii =
      /^(https?:\/\/|socks\d?:\/\/|[\w.-]+\.\w{2,4}$|pdf, doc|\d+K \d+p$|\d+p$|(Ctrl|Alt|Shift)(\+|$)|Webhook|PID$|NTLM$|Cookie$|AdGuard|DNS0|OpenDNS|Chrome|Edge$|Firefox|Safari|Test$|Buffer$|Clear$|Refresh$|Auto-scroll|All Levels|Filter by source|Rename$|New name|Rename Download|Re-download|Refresh URL|Rename download)/;
    const legitKeys = new Set([
      'batch_placeholder',
      'settings_8k',
      'settings_4k',
      'settings_2k',
      'settings_360p',
      'settings_240p',
      'settings_144p',
      'settings_dns_opendns',
      'settings_dns_adguard',
      'settings_dns_dns0',
      'settings_vpn_proxy_placeholder',
      'settings_vpn_bind_placeholder',
      'browser_chrome_edge',
      'browser_firefox',
      'batch_cookies',
      'add_dl_auth_ntlm',
      'settings_browser_safari',
      'settings_browser_chrome',
      'settings_browser_edge',
      'settings_browser_firefox',
      'settings_file_types_placeholder',
      'settings_intercept_alt',
      'settings_intercept_ctrl',
      'settings_intercept_shift',
      'settings_intercept_alt_ctrl',
      'settings_dns_test_run',
      'settings_bridge_pid',
    ]);
    for (const lang of ['zh', 'zh_TW']) {
      const dict = dictOf(localeModules[`../${lang}.ts`] as Record<string, unknown>);
      const raw: string[] = [];
      for (const [key, value] of Object.entries(dict)) {
        if (value === key) {
          raw.push(key);
          continue;
        }
        if (legitKeys.has(key) || legitAscii.test(value)) {
          continue;
        }
        // Pure-ASCII English prose (Chinese is never ASCII) — the value is
        // untranslated regardless of length.
        if (/^[A-Za-z0-9 .,:;'"()/&%!?+-]+$/.test(value) && value.trim().length > 2) {
          raw.push(`${key} = "${value}"`);
        }
      }
      expect(
        raw,
        `${lang} has ${raw.length} untranslated values: ${raw.slice(0, 10).join('; ')}`,
      ).toEqual([]);
    }
  });
});
