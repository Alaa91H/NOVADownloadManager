import { afterEach, describe, expect, it, vi } from 'vitest';

// The i18n entry imports webextension-polyfill, which refuses to load outside an
// extension. Stub it so we can exercise the real resolver/translator behaviour.
const { getUILanguage } = vi.hoisted(() => ({ getUILanguage: vi.fn<() => string | undefined>(() => 'en') }));
vi.mock('webextension-polyfill', () => ({ default: { i18n: { getUILanguage } } }));

const {
  LOCALES,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  normalizeUiLanguage,
  translate,
  createTranslator,
  getLocaleBundle,
  getDefaultLocale,
} = await import('../../i18n');
const { overlayTranslations, translateOverlay } = await import('../../content/overlay-i18n');

afterEach(() => {
  getUILanguage.mockReturnValue('en');
});

describe('normalizeUiLanguage', () => {
  it('maps exact supported codes', () => {
    for (const code of SUPPORTED_LOCALES) {
      expect(normalizeUiLanguage(code)).toBe(code);
    }
  });

  it('falls back to the primary subtag for regional variants', () => {
    expect(normalizeUiLanguage('pt-BR')).toBe('pt');
    expect(normalizeUiLanguage('zh-CN')).toBe('zh');
    expect(normalizeUiLanguage('fr-CA')).toBe('fr');
    expect(normalizeUiLanguage('en-US')).toBe('en');
  });

  it('normalizes case and underscore separators', () => {
    expect(normalizeUiLanguage('AR')).toBe('ar');
    expect(normalizeUiLanguage('pt_BR')).toBe('pt');
    expect(normalizeUiLanguage('  De  ')).toBe('de');
  });

  it('falls back to the default locale for unknown, empty, or missing input', () => {
    expect(normalizeUiLanguage('xx')).toBe(DEFAULT_LOCALE);
    expect(normalizeUiLanguage('klingon')).toBe(DEFAULT_LOCALE);
    expect(normalizeUiLanguage('')).toBe(DEFAULT_LOCALE);
    expect(normalizeUiLanguage(undefined)).toBe(DEFAULT_LOCALE);
    expect(normalizeUiLanguage(null)).toBe(DEFAULT_LOCALE);
  });
});

describe('locale registry', () => {
  it('registers 25 world languages with consistent key sets', () => {
    expect(SUPPORTED_LOCALES).toHaveLength(25);
    const baseKeys = Object.keys(LOCALES[DEFAULT_LOCALE].strings).sort();
    for (const code of SUPPORTED_LOCALES) {
      expect(Object.keys(LOCALES[code].strings).sort()).toEqual(baseKeys);
    }
  });

  it('keeps download notification titles translated in every supported locale', () => {
    const keys = ['notification.downloadStarted', 'notification.downloadComplete', 'notification.downloadFailed'] as const;
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of keys) {
        const value = LOCALES[locale].strings[key];
        expect(value).toBeTruthy();
        expect(value).not.toBe(key);
      }
    }
    expect(translate('notification.downloadStarted', 'ar')).toBe('بدأ التنزيل');
    expect(translate('notification.downloadComplete', 'zh')).toBe('下载完成');
  });

  it('marks Arabic and Persian as right-to-left and the rest as left-to-right', () => {
    expect(getLocaleBundle('ar').direction).toBe('rtl');
    expect(getLocaleBundle('fa').direction).toBe('rtl');
    expect(getLocaleBundle('he').direction).toBe('rtl');
    expect(getLocaleBundle('en').direction).toBe('ltr');
    expect(getLocaleBundle('ja').direction).toBe('ltr');
  });
});

describe('translate', () => {
  it('returns the localized string for a known key', () => {
    expect(translate('videoOverlay.download', 'en')).toBe('Download');
    expect(translate('videoOverlay.download', 'ar')).toBe('تحميل');
    expect(translate('videoOverlay.download', 'ja')).toBe('ダウンロード');
  });

  it('returns the key itself when the message is unknown', () => {
    // @ts-expect-error intentionally unknown key to exercise the fallback path
    expect(translate('does.not.exist', 'en')).toBe('does.not.exist');
  });

  it('createTranslator binds a locale', () => {
    const t = createTranslator('ar');
    expect(t('videoOverlay.close')).toBe('إغلاق');
  });
});

describe('compact overlay translations', () => {
  it('keeps all 25 locale maps aligned and resolves the safe tool remedy locally', () => {
    const expectedKeys = Object.keys(overlayTranslations.en).sort() as Array<keyof typeof overlayTranslations.en>;
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(overlayTranslations[locale]).sort()).toEqual(expectedKeys);
      for (const key of expectedKeys) {
        expect(overlayTranslations[locale][key]).toBe(LOCALES[locale].strings[key]);
      }
    }

    getUILanguage.mockReturnValue('ar-EG');
    expect(translateOverlay('videoOverlay.toolUnavailable')).toBe('ثبّت أو أصلح yt-dlp في NOVA، ثم أعد التحليل.');
    expect(translateOverlay('quality.header', { n: 3 })).toContain('3');
  });
});

describe('getDefaultLocale', () => {
  it('derives the locale from the browser UI language', () => {
    getUILanguage.mockReturnValue('ar-EG');
    expect(getDefaultLocale()).toBe('ar');

    getUILanguage.mockReturnValue('de-DE');
    expect(getDefaultLocale()).toBe('de');

    getUILanguage.mockReturnValue('sw-KE'); // unsupported -> default
    expect(getDefaultLocale()).toBe(DEFAULT_LOCALE);
  });
});
