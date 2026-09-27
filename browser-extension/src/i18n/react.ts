import { useMemo, useSyncExternalStore } from 'react';
import { createTranslator, getDefaultLocale, getLocaleBundle } from './index';
import type { LocaleCode } from './types';

function subscribeToLocale(callback: () => void): () => void {
  window.addEventListener('languagechange', callback);
  return () => window.removeEventListener('languagechange', callback);
}

function getSnapshot(): LocaleCode {
  return getDefaultLocale();
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribeToLocale, getSnapshot);
  return useMemo(() => {
    const bundle = getLocaleBundle(locale);
    return {
      locale,
      direction: bundle.direction,
      languageName: bundle.languageName,
      t: createTranslator(locale),
    };
  }, [locale]);
}
