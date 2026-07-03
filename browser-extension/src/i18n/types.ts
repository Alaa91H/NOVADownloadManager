import type { en } from './locales/en';

export type LocaleCode =
  | 'en'
  | 'ar'
  | 'es'
  | 'fr'
  | 'de'
  | 'pt'
  | 'it'
  | 'ru'
  | 'tr'
  | 'hi'
  | 'id'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'fa'
  | 'bn'
  | 'vi'
  | 'th'
  | 'pl'
  | 'uk'
  | 'nl'
  | 'el'
  | 'he'
  | 'sv'
  | 'ro';
export type LocaleDirection = 'ltr' | 'rtl';
export type MessageKey = keyof typeof en.strings;
export type LocaleBundle = {
  direction: LocaleDirection;
  languageName: string;
  strings: Record<MessageKey, string>;
};
export type TranslateFunction = (key: MessageKey, replacements?: Record<string, string | number>) => string;
