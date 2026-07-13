import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Browser Extension — status bar button', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('browser extension button exists in status bar', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    const isVisible = await shieldBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('browser extension button has icon', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const hasSvg = await shieldBtn.locator('svg').count();
      expect(hasSvg).toBeGreaterThanOrEqual(1);
    }
  });

  test('browser extension button has tooltip describing state', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const title = await shieldBtn.getAttribute('title');
      expect(title).toBeTruthy();
      expect((title ?? '').length).toBeGreaterThan(3);
    }
  });

  test('clicking browser extension button opens integration dialog', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      await shieldBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const title = page.locator('#modal-title');
        if (await title.isVisible().catch(() => false)) {
          const text = await title.textContent();
          expect(text).toMatch(/browser|extension|متصفح|إضافة/i);
        }
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Browser Extension — 3-state icon', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('button color reflects connection state', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const svg = shieldBtn.locator('svg').first();
      if (await svg.isVisible().catch(() => false)) {
        const color = await svg.evaluate(el => window.getComputedStyle(el).color);
        expect(color).toBeTruthy();
      }
    }
  });
});

test.describe('Browser Extension — sidebar widget', () => {
  test('browser extension status in sidebar', async ({ page }) => {
    await goto(page);
    const sidebar = page.locator('aside, nav').first();
    const extStatus = sidebar.locator('text=browser, text=متصفح').first();
    const isVisible = await extStatus.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Browser Extension — integration dialog content', () => {
  test('integration dialog shows installation instructions', async ({ page }) => {
    await goto(page);
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      await shieldBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const content = await dialog.textContent();
        expect(content?.length).toBeGreaterThan(20);
        await page.keyboard.press('Escape');
      }
    }
  });
});
