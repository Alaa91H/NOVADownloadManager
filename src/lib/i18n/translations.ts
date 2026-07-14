import { en } from './en';

export type Language = 'en' | 'ar' | 'bg' | 'bn' | 'cs' | 'da' | 'de' | 'el' | 'es' | 'fa' | 'fi' | 'fr' | 'he' | 'hi' | 'hu' | 'id' | 'it' | 'ja' | 'ko' | 'ms' | 'nl' | 'no' | 'pl' | 'pt' | 'ro' | 'ru' | 'sk' | 'sv' | 'th' | 'tr' | 'uk' | 'ur' | 'vi' | 'zh' | 'zh-TW';

const loaders: Record<Language, () => Promise<Record<string, unknown>>> = {
  'en': () => Promise.resolve({ en }),
  'ar': () => import('./ar'),
  'bg': () => import('./bg'),
  'bn': () => import('./bn'),
  'cs': () => import('./cs'),
  'da': () => import('./da'),
  'de': () => import('./de'),
  'el': () => import('./el'),
  'es': () => import('./es'),
  'fa': () => import('./fa'),
  'fi': () => import('./fi'),
  'fr': () => import('./fr'),
  'he': () => import('./he'),
  'hi': () => import('./hi'),
  'hu': () => import('./hu'),
  'id': () => import('./id'),
  'it': () => import('./it'),
  'ja': () => import('./ja'),
  'ko': () => import('./ko'),
  'ms': () => import('./ms'),
  'nl': () => import('./nl'),
  'no': () => import('./no'),
  'pl': () => import('./pl'),
  'pt': () => import('./pt'),
  'ro': () => import('./ro'),
  'ru': () => import('./ru'),
  'sk': () => import('./sk'),
  'sv': () => import('./sv'),
  'th': () => import('./th'),
  'tr': () => import('./tr'),
  'uk': () => import('./uk'),
  'ur': () => import('./ur'),
  'vi': () => import('./vi'),
  'zh': () => import('./zh'),
  'zh-TW': () => import('./zh_TW'),
};

const cache: Partial<Record<Language, Record<string, string>>> = { en };

function normalizeLanguage(lang: string): Language {
  return (lang in loaders ? lang : 'en') as Language;
}

export function isLanguageLoaded(lang: string): boolean {
  return Boolean(cache[normalizeLanguage(lang)]);
}

export async function loadLanguage(lang: string): Promise<void> {
  const code = normalizeLanguage(lang);
  if (cache[code]) return;
  const module = await loaders[code]();
  const dict = Object.values(module).find(value => value && typeof value === 'object');
  if (dict) cache[code] = dict as Record<string, string>;
}

export function getTranslation(
  lang: string,
  key: string,
  params?: Record<string, string | number>
): string {
  const dict = cache[normalizeLanguage(lang)] || en;
  let text = dict[key] || en[key] || key;

  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      text = text.replace(`{${k}}`, String(v));
    });
  }
  return text;
}
