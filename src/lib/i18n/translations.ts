import { en } from './en';

export type Language =
  | 'en'
  | 'af'
  | 'sq'
  | 'am'
  | 'ar'
  | 'hy'
  | 'as'
  | 'ay'
  | 'az'
  | 'bm'
  | 'eu'
  | 'be'
  | 'bn'
  | 'bho'
  | 'bs'
  | 'bg'
  | 'ca'
  | 'ceb'
  | 'ny'
  | 'zh'
  | 'zh-TW'
  | 'co'
  | 'hr'
  | 'cs'
  | 'da'
  | 'dv'
  | 'doi'
  | 'nl'
  | 'eo'
  | 'et'
  | 'ee'
  | 'tl'
  | 'fi'
  | 'fr'
  | 'fy'
  | 'gl'
  | 'ka'
  | 'de'
  | 'el'
  | 'gn'
  | 'gu'
  | 'ht'
  | 'ha'
  | 'haw'
  | 'he'
  | 'hi'
  | 'hmn'
  | 'hu'
  | 'is'
  | 'ig'
  | 'ilo'
  | 'id'
  | 'ga'
  | 'it'
  | 'ja'
  | 'jw'
  | 'kn'
  | 'kk'
  | 'km'
  | 'rw'
  | 'gom'
  | 'ko'
  | 'kri'
  | 'ku'
  | 'ckb'
  | 'ky'
  | 'lo'
  | 'la'
  | 'lv'
  | 'ln'
  | 'lt'
  | 'lg'
  | 'lb'
  | 'mk'
  | 'mai'
  | 'mg'
  | 'ms'
  | 'ml'
  | 'mt'
  | 'mi'
  | 'mr'
  | 'mni-Mtei'
  | 'lus'
  | 'mn'
  | 'my'
  | 'ne'
  | 'no'
  | 'or'
  | 'om'
  | 'ps'
  | 'fa'
  | 'pl'
  | 'pt'
  | 'pa'
  | 'qu'
  | 'ro'
  | 'ru'
  | 'sm'
  | 'sa'
  | 'gd'
  | 'nso'
  | 'sr'
  | 'st'
  | 'sn'
  | 'sd'
  | 'si'
  | 'sk'
  | 'sl'
  | 'so'
  | 'es'
  | 'su'
  | 'sw'
  | 'sv'
  | 'tg'
  | 'ta'
  | 'tt'
  | 'te'
  | 'th'
  | 'ti'
  | 'ts'
  | 'tr'
  | 'tk'
  | 'uk'
  | 'ur'
  | 'ug'
  | 'uz'
  | 'vi'
  | 'cy'
  | 'xh'
  | 'yi'
  | 'yo'
  | 'zu';

// English ships in the main bundle as the synchronous fallback; every other
// language is loaded on demand as its own chunk to keep startup fast.
const loaders: Record<Language, () => Promise<Record<string, unknown>>> = {
  en: async () => ({ en }),
  af: () => import('./af'),
  sq: () => import('./sq'),
  am: () => import('./am'),
  ar: () => import('./ar'),
  hy: () => import('./hy'),
  as: () => import('./as'),
  ay: () => import('./ay'),
  az: () => import('./az'),
  bm: () => import('./bm'),
  eu: () => import('./eu'),
  be: () => import('./be'),
  bn: () => import('./bn'),
  bho: () => import('./bho'),
  bs: () => import('./bs'),
  bg: () => import('./bg'),
  ca: () => import('./ca'),
  ceb: () => import('./ceb'),
  ny: () => import('./ny'),
  zh: () => import('./zh'),
  'zh-TW': () => import('./zh_TW'),
  co: () => import('./co'),
  hr: () => import('./hr'),
  cs: () => import('./cs'),
  da: () => import('./da'),
  dv: () => import('./dv'),
  doi: () => import('./doi'),
  nl: () => import('./nl'),
  eo: () => import('./eo'),
  et: () => import('./et'),
  ee: () => import('./ee'),
  tl: () => import('./tl'),
  fi: () => import('./fi'),
  fr: () => import('./fr'),
  fy: () => import('./fy'),
  gl: () => import('./gl'),
  ka: () => import('./ka'),
  de: () => import('./de'),
  el: () => import('./el'),
  gn: () => import('./gn'),
  gu: () => import('./gu'),
  ht: () => import('./ht'),
  ha: () => import('./ha'),
  haw: () => import('./haw'),
  he: () => import('./he'),
  hi: () => import('./hi'),
  hmn: () => import('./hmn'),
  hu: () => import('./hu'),
  is: () => import('./is'),
  ig: () => import('./ig'),
  ilo: () => import('./ilo'),
  id: () => import('./id'),
  ga: () => import('./ga'),
  it: () => import('./it'),
  ja: () => import('./ja'),
  jw: () => import('./jw'),
  kn: () => import('./kn'),
  kk: () => import('./kk'),
  km: () => import('./km'),
  rw: () => import('./rw'),
  gom: () => import('./gom'),
  ko: () => import('./ko'),
  kri: () => import('./kri'),
  ku: () => import('./ku'),
  ckb: () => import('./ckb'),
  ky: () => import('./ky'),
  lo: () => import('./lo'),
  la: () => import('./la'),
  lv: () => import('./lv'),
  ln: () => import('./ln'),
  lt: () => import('./lt'),
  lg: () => import('./lg'),
  lb: () => import('./lb'),
  mk: () => import('./mk'),
  mai: () => import('./mai'),
  mg: () => import('./mg'),
  ms: () => import('./ms'),
  ml: () => import('./ml'),
  mt: () => import('./mt'),
  mi: () => import('./mi'),
  mr: () => import('./mr'),
  'mni-Mtei': () => import('./mni_Mtei'),
  lus: () => import('./lus'),
  mn: () => import('./mn'),
  my: () => import('./my'),
  ne: () => import('./ne'),
  no: () => import('./no'),
  or: () => import('./or'),
  om: () => import('./om'),
  ps: () => import('./ps'),
  fa: () => import('./fa'),
  pl: () => import('./pl'),
  pt: () => import('./pt'),
  pa: () => import('./pa'),
  qu: () => import('./qu'),
  ro: () => import('./ro'),
  ru: () => import('./ru'),
  sm: () => import('./sm'),
  sa: () => import('./sa'),
  gd: () => import('./gd'),
  nso: () => import('./nso'),
  sr: () => import('./sr'),
  st: () => import('./st'),
  sn: () => import('./sn'),
  sd: () => import('./sd'),
  si: () => import('./si'),
  sk: () => import('./sk'),
  sl: () => import('./sl'),
  so: () => import('./so'),
  es: () => import('./es'),
  su: () => import('./su'),
  sw: () => import('./sw'),
  sv: () => import('./sv'),
  tg: () => import('./tg'),
  ta: () => import('./ta'),
  tt: () => import('./tt'),
  te: () => import('./te'),
  th: () => import('./th'),
  ti: () => import('./ti'),
  ts: () => import('./ts'),
  tr: () => import('./tr'),
  tk: () => import('./tk'),
  uk: () => import('./uk'),
  ur: () => import('./ur'),
  ug: () => import('./ug'),
  uz: () => import('./uz'),
  vi: () => import('./vi'),
  cy: () => import('./cy'),
  xh: () => import('./xh'),
  yi: () => import('./yi'),
  yo: () => import('./yo'),
  zu: () => import('./zu'),
};

const cache: Partial<Record<Language, Record<string, string>>> = { en };

function normalizeLanguage(lang: string): Language {
  return (lang in loaders ? lang : 'en') as Language;
}

export function isLanguageLoaded(lang: string): boolean {
  return Boolean(cache[normalizeLanguage(lang)]);
}

export async function loadLanguage(lang: string): Promise<void> {
  try {
    const code = normalizeLanguage(lang);
    if (cache[code]) return;
    const module = await loaders[code]();
    const dict = Object.values(module).find((value) => value && typeof value === 'object');
    if (dict) cache[code] = dict as Record<string, string>;
  } catch (e) {
    console.warn(`Failed to load language "${lang}":`, e);
    // Fall back to English
    if (lang !== 'en') {
      return loadLanguage('en');
    }
  }
}

export function getTranslation(lang: string, key: string, params?: Record<string, string | number>): string {
  const dict = cache[normalizeLanguage(lang)] || en;
  let text = dict[key] || en[key] || key;

  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      text = text.replace(`{${k}}`, String(v));
    });
  }
  return text;
}
