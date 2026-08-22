import { describe, expect, it } from 'vitest';
import { getLanguageDirection, LANGUAGE_METADATA } from '../languageMetadata';

describe('language metadata', () => {
  it('marks the supported right-to-left languages explicitly', () => {
    for (const language of ['ar', 'ckb', 'dv', 'fa', 'he', 'ps', 'sd', 'ug', 'ur', 'yi']) {
      expect(getLanguageDirection(language)).toBe('rtl');
    }
  });

  it('keeps left-to-right languages and unknown codes in a safe default direction', () => {
    expect(getLanguageDirection('en')).toBe('ltr');
    expect(getLanguageDirection('de')).toBe('ltr');
    expect(getLanguageDirection('unknown-language')).toBe('ltr');
  });

  it('gives every catalog language exactly one explicit direction', () => {
    expect(LANGUAGE_METADATA).toHaveLength(132);
    expect(LANGUAGE_METADATA.every((language) => language.direction === 'ltr' || language.direction === 'rtl')).toBe(true);
  });
});
