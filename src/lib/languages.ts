import { LANGUAGE_METADATA } from './i18n/languageMetadata';
import type { Language } from './i18n/translations';

export const PRIMARY_LANGUAGE_CODES = [
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
] as const satisfies readonly Language[];

const PRIMARY_LANGUAGE_LABELS: Record<(typeof PRIMARY_LANGUAGE_CODES)[number], { label: string; subLabel: string }> = {
  en: { label: 'English', subLabel: 'English' },
  ar: { label: 'Arabic', subLabel: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629' },
  fr: { label: 'French', subLabel: 'Fran\u00e7ais' },
  es: { label: 'Spanish', subLabel: 'Espa\u00f1ol' },
  de: { label: 'German', subLabel: 'Deutsch' },
  pt: { label: 'Portuguese', subLabel: 'Portugu\u00eas' },
  ru: { label: 'Russian', subLabel: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439' },
  zh: { label: 'Chinese Simplified', subLabel: '\u7b80\u4f53\u4e2d\u6587' },
  'zh-TW': { label: 'Chinese Traditional', subLabel: '\u7e41\u9ad4\u4e2d\u6587' },
  hi: { label: 'Hindi', subLabel: '\u0939\u093f\u0928\u094d\u0926\u0940' },
  bn: { label: 'Bengali', subLabel: '\u09ac\u09be\u0982\u09b2\u09be' },
  ur: { label: 'Urdu', subLabel: '\u0627\u0631\u062f\u0648' },
  id: { label: 'Indonesian', subLabel: 'Bahasa Indonesia' },
  ja: { label: 'Japanese', subLabel: '\u65e5\u672c\u8a9e' },
  ko: { label: 'Korean', subLabel: '\ud55c\uad6d\uc5b4' },
  tr: { label: 'Turkish', subLabel: 'T\u00fcrk\u00e7e' },
  fa: { label: 'Persian', subLabel: '\u0641\u0627\u0631\u0633\u06cc' },
  vi: { label: 'Vietnamese', subLabel: 'Ti\u1ebfng Vi\u1ec7t' },
  it: { label: 'Italian', subLabel: 'Italiano' },
  nl: { label: 'Dutch', subLabel: 'Nederlands' },
};

export const WORLD_LANGUAGES = PRIMARY_LANGUAGE_CODES.map((code) => {
  const fallback = LANGUAGE_METADATA.find((language) => language.value === code);
  return {
    value: code,
    label: PRIMARY_LANGUAGE_LABELS[code].label || fallback?.label || code,
    subLabel: PRIMARY_LANGUAGE_LABELS[code].subLabel || fallback?.subLabel || code,
  };
});
