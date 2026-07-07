import { describe, it, expect } from 'vitest';
import { WORLD_LANGUAGES } from '../languages';

describe('WORLD_LANGUAGES', () => {
  it('is an array', () => {
    expect(Array.isArray(WORLD_LANGUAGES)).toBe(true);
  });

  it('has English as first entry', () => {
    expect(WORLD_LANGUAGES[0].value).toBe('en');
    expect(WORLD_LANGUAGES[0].label).toBe('English');
  });

  it('sorts remaining entries alphabetically', () => {
    const sorted = [...WORLD_LANGUAGES].slice(1).sort((a, b) => a.label.localeCompare(b.label));
    const afterEnglish = WORLD_LANGUAGES.slice(1);
    for (let i = 0; i < afterEnglish.length; i++) {
      expect(afterEnglish[i].label).toBe(sorted[i].label);
    }
  });

  it('each entry has required fields', () => {
    for (const lang of WORLD_LANGUAGES) {
      expect(lang).toHaveProperty('value');
      expect(lang).toHaveProperty('label');
      expect(lang).toHaveProperty('subLabel');
      expect(typeof lang.value).toBe('string');
      expect(typeof lang.label).toBe('string');
      expect(typeof lang.subLabel).toBe('string');
    }
  });
});
