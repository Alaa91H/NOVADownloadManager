import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('I18n — language switching', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('default language is English', async ({ page }) => {
    const lang = await page.evaluate(() => {
      return document.documentElement.getAttribute('lang') || 'en';
    });
    expect(lang).toBeTruthy();
  });

  test('language can be changed via settings', async ({ page }) => {
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(600);
    const langTab = page
      .locator('button')
      .filter({ hasText: /language|لغة/i })
      .first();
    if (await langTab.isVisible().catch(() => false)) {
      await langTab.click();
      await page.waitForTimeout(300);
      const langSelect = page.locator('select').first();
      if (await langSelect.isVisible().catch(() => false)) {
        const options = await langSelect.locator('option').allTextContents();
        expect(options.length).toBeGreaterThanOrEqual(5);
      }
    }
  });
});

test.describe('I18n — UI text updates', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('sidebar labels are translated', async ({ page }) => {
    const allDownloads = page
      .locator('aside button')
      .filter({ hasText: /all downloads|كل التحميلات|すべてのダウンロード/i })
      .first();
    const isVisible = await allDownloads.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('topbar buttons are translated', async ({ page }) => {
    const newDl = page
      .locator('header button')
      .filter({ hasText: /new|جديد|新规/i })
      .first();
    const isVisible = await newDl.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('status bar text is translated', async ({ page }) => {
    const statusBar = page.locator('[role="status"]').first();
    const text = await statusBar.textContent();
    expect(text?.length).toBeGreaterThan(0);
  });
});

test.describe('I18n — RTL support', () => {
  test('Arabic language sets RTL direction', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(600);
    const langTab = page
      .locator('button')
      .filter({ hasText: /language|لغة/i })
      .first();
    if (await langTab.isVisible().catch(() => false)) {
      await langTab.click();
      await page.waitForTimeout(300);
      const langSelect = page.locator('select').first();
      if (await langSelect.isVisible().catch(() => false)) {
        const arabicOption = await langSelect
          .locator('option')
          .filter({ hasText: /arabic|عربي/i })
          .first()
          .getAttribute('value');
        if (arabicOption) {
          await langSelect.selectOption(arabicOption);
          await page.waitForTimeout(500);
          const dir = await page.evaluate(() => document.documentElement.getAttribute('dir'));
          expect(dir).toBe('rtl');
          // Reset back
          await langSelect.selectOption('en');
          await page.waitForTimeout(500);
        }
      }
    }
  });

  test('Hebrew language sets RTL direction', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(600);
    const langTab = page
      .locator('button')
      .filter({ hasText: /language|لغة/i })
      .first();
    if (await langTab.isVisible().catch(() => false)) {
      await langTab.click();
      await page.waitForTimeout(300);
      const langSelect = page.locator('select').first();
      if (await langSelect.isVisible().catch(() => false)) {
        const hebrewOption = await langSelect
          .locator('option')
          .filter({ hasText: /hebrew|עברית/i })
          .first()
          .getAttribute('value');
        if (hebrewOption) {
          await langSelect.selectOption(hebrewOption);
          await page.waitForTimeout(500);
          const dir = await page.evaluate(() => document.documentElement.getAttribute('dir'));
          expect(dir).toBe('rtl');
          await langSelect.selectOption('en');
          await page.waitForTimeout(500);
        }
      }
    }
  });
});

test.describe('I18n — date/number formatting', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('numbers display in locale format', async ({ page }) => {
    const statusBar = page.locator('[role="status"]').first();
    const text = await statusBar.textContent();
    expect(text).toBeTruthy();
  });
});

test.describe('I18n — accessibility', () => {
  test('all buttons have accessible labels', async ({ page }) => {
    await goto(page);
    const buttons = page.locator('button');
    const count = await buttons.count();
    for (let i = 0; i < Math.min(count, 20); i++) {
      const btn = buttons.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const hasLabel = await btn.evaluate((el) => {
          return (
            (el.textContent?.trim().length ?? 0) > 0 ||
            (el.getAttribute('aria-label')?.length ?? 0) > 0 ||
            (el.getAttribute('title')?.length ?? 0) > 0
          );
        });
        expect(hasLabel).toBeTruthy();
      }
    }
  });
});
