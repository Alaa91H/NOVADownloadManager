import browser from 'webextension-polyfill';
import { ar } from './locales/ar';
import { bn } from './locales/bn';
import { de } from './locales/de';
import { el } from './locales/el';
import { en } from './locales/en';
import { es } from './locales/es';
import { fa } from './locales/fa';
import { fr } from './locales/fr';
import { he } from './locales/he';
import { hi } from './locales/hi';
import { id } from './locales/id';
import { it } from './locales/it';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { nl } from './locales/nl';
import { pl } from './locales/pl';
import { pt } from './locales/pt';
import { ro } from './locales/ro';
import { ru } from './locales/ru';
import { sv } from './locales/sv';
import { th } from './locales/th';
import { tr } from './locales/tr';
import { uk } from './locales/uk';
import { vi } from './locales/vi';
import { zh } from './locales/zh';
import type { LocaleBundle, LocaleCode, MessageKey, TranslateFunction } from './types';

export type { LocaleBundle, LocaleCode, LocaleDirection, MessageKey, TranslateFunction } from './types';

export const DEFAULT_LOCALE: LocaleCode = 'en';

// Global language registry. Adding a world language is a single entry here plus its
// bundle under ./locales — the resolver and every consumer pick it up automatically.
export const LOCALES: Record<LocaleCode, LocaleBundle> = {
  en, ar, bn, de, el, es, fa, fr, he, hi, id, it, ja, ko, nl, pl, pt, ro, ru, sv, th, tr, uk, vi, zh,
};

export const SUPPORTED_LOCALES = Object.keys(LOCALES) as LocaleCode[];

function isSupportedLocale(code: string): code is LocaleCode {
  return Object.prototype.hasOwnProperty.call(LOCALES, code);
}

function navigatorUiLanguage(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return navigator.languages?.[0] ?? navigator.language;
}

export function normalizeUiLanguage(rawLanguage?: string | null): LocaleCode {
  const normalized = rawLanguage?.trim().replace('_', '-').toLowerCase();
  if (!normalized) return DEFAULT_LOCALE;
  // Prefer an exact match (e.g. "pt-br"), then fall back to the primary subtag ("pt").
  if (isSupportedLocale(normalized)) return normalized;
  const primary = normalized.split('-', 1)[0];
  return primary && isSupportedLocale(primary) ? primary : DEFAULT_LOCALE;
}

export function getBrowserUiLanguage(): string {
  try {
    const browserLanguage = browser.i18n?.getUILanguage?.();
    if (browserLanguage) return browserLanguage;
  } catch {
    // The browser API can be absent in mocked or restricted extension contexts.
  }
  return navigatorUiLanguage() ?? DEFAULT_LOCALE;
}

export function getDefaultLocale(): LocaleCode {
  return normalizeUiLanguage(getBrowserUiLanguage());
}

export function getLocaleBundle(locale: LocaleCode = getDefaultLocale()): LocaleBundle {
  return LOCALES[locale];
}

export function translate(key: MessageKey, locale: LocaleCode = getDefaultLocale(), replacements?: Record<string, string | number>): string {
  let value = getLocaleBundle(locale).strings[key] ?? LOCALES[DEFAULT_LOCALE].strings[key] ?? key;
  if (!replacements) return value;
  for (const [name, replacement] of Object.entries(replacements)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

export function createTranslator(locale: LocaleCode = getDefaultLocale()): TranslateFunction {
  return (key, replacements) => translate(key, locale, replacements);
}

export function applyDocumentLocale(locale: LocaleCode = getDefaultLocale()): void {
  if (typeof document === 'undefined') return;
  const bundle = getLocaleBundle(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = bundle.direction;
  document.documentElement.dataset.locale = locale;
}
