import { describe, it, expect } from 'vitest';
import { loadLanguage, getTranslation, isLanguageLoaded } from '../translations';

describe('translations', () => {
  it('loads English and returns a key', async () => {
    await loadLanguage('en');
    expect(isLanguageLoaded('en')).toBe(true);
    const result = getTranslation('en', 'all_downloads');
    expect(result).toBe('All Downloads');
    expect(typeof result).toBe('string');
  });

  it('returns key as fallback for missing key', () => {
    const result = getTranslation('en', 'nonexistent_key_xyz');
    expect(result).toBe('nonexistent_key_xyz');
  });
});
