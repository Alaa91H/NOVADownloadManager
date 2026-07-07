import { describe, it, expect } from 'vitest';
import { LANGUAGE_METADATA } from '../languageMetadata';

describe('LANGUAGE_METADATA', () => {
  it('is an array', () => {
    expect(Array.isArray(LANGUAGE_METADATA)).toBe(true);
  });

  it('has more than 100 languages', () => {
    expect(LANGUAGE_METADATA.length).toBeGreaterThan(100);
  });

  it('includes English', () => {
    const en = LANGUAGE_METADATA.find((l) => l.value === 'en');
    expect(en).toBeDefined();
    expect(en!.label).toBe('English');
  });

  it('includes Arabic', () => {
    const ar = LANGUAGE_METADATA.find((l) => l.value === 'ar');
    expect(ar).toBeDefined();
    expect(ar!.label).toBe('Arabic');
  });

  it('every entry has valid fields', () => {
    for (const lang of LANGUAGE_METADATA) {
      expect(lang).toHaveProperty('value');
      expect(lang).toHaveProperty('label');
      expect(lang).toHaveProperty('subLabel');
      expect(typeof lang.value).toBe('string');
      expect(typeof lang.label).toBe('string');
      expect(typeof lang.subLabel).toBe('string');
      expect(lang.value.length).toBeGreaterThan(0);
      expect(lang.label.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate values', () => {
    const values = LANGUAGE_METADATA.map((l) => l.value);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });

  it('has the correct number of entries', () => {
    expect(LANGUAGE_METADATA.length).toBe(134);
  });
});
