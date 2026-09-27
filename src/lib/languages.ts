import { LANGUAGE_METADATA } from './i18n/languageMetadata';

export const WORLD_LANGUAGES = [...LANGUAGE_METADATA].sort((a, b) => {
  if (a.value === 'en') return -1;
  if (b.value === 'en') return 1;
  return a.label.localeCompare(b.label);
});
