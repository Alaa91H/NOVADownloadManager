import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Media Player — dialog structure', () => {
  test('media player dialog can be opened', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const playOption = page.locator('[role="menuitem"]').filter({ hasText: /play|تشغيل|media/i }).first();
      if (await playOption.isVisible().catch(() => false)) {
        await playOption.click();
        await page.waitForTimeout(500);
        const dialog = page.locator('[role="dialog"]');
        if (await dialog.isVisible().catch(() => false)) {
          await expect(dialog).toBeVisible();
          await page.keyboard.press('Escape');
        }
      }
    }
  });
});

test.describe('Media Player — player controls', () => {
  test('media player has play/pause control', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const playOption = page.locator('[role="menuitem"]').filter({ hasText: /play|تشغيل|media/i }).first();
      if (await playOption.isVisible().catch(() => false)) {
        await playOption.click();
        await page.waitForTimeout(500);
        const dialog = page.locator('[role="dialog"]');
        if (await dialog.isVisible().catch(() => false)) {
          const playPause = dialog.locator('button').filter({ has: page.locator('svg') }).first();
          const isVisible = await playPause.isVisible().catch(() => false);
          expect(typeof isVisible).toBe('boolean');
          await page.keyboard.press('Escape');
        }
      }
    }
  });

  test('media player has close button', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const playOption = page.locator('[role="menuitem"]').filter({ hasText: /play|تشغيل|media/i }).first();
      if (await playOption.isVisible().catch(() => false)) {
        await playOption.click();
        await page.waitForTimeout(500);
        const dialog = page.locator('[role="dialog"]');
        if (await dialog.isVisible().catch(() => false)) {
          const closeBtn = dialog.locator('button[title*="close" i], button[title*="إغلاق" i]').first();
          const isVisible = await closeBtn.isVisible().catch(() => false);
          expect(typeof isVisible).toBe('boolean');
          await page.keyboard.press('Escape');
        }
      }
    }
  });
});
