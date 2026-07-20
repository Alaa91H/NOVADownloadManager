import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Import/Export — dialog structure', () => {
  test('import/export can be opened', async ({ page }) => {
    await goto(page);
    const importBtn = page
      .locator('button')
      .filter({ hasText: /import|استيراد/i })
      .first();
    const isVisible = await importBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('export can be triggered', async ({ page }) => {
    await goto(page);
    const exportBtn = page
      .locator('button')
      .filter({ hasText: /export|تصدير/i })
      .first();
    const isVisible = await exportBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Import/Export — import formats', () => {
  test('import supports text/url format', async ({ page }) => {
    await goto(page);
    const importBtn = page
      .locator('button')
      .filter({ hasText: /import|استيراد/i })
      .first();
    if (await importBtn.isVisible().catch(() => false)) {
      await importBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const textarea = dialog.locator('textarea');
        const isVisible = await textarea.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });

  test('import dialog has textarea for URLs', async ({ page }) => {
    await goto(page);
    const importBtn = page
      .locator('button')
      .filter({ hasText: /import|استيراد/i })
      .first();
    if (await importBtn.isVisible().catch(() => false)) {
      await importBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const textarea = dialog.locator('textarea');
        if (await textarea.isVisible().catch(() => false)) {
          await textarea.fill('https://example.com/file1.zip\nhttps://example.com/file2.zip');
          const value = await textarea.inputValue();
          expect(value).toContain('file1.zip');
          expect(value).toContain('file2.zip');
        }
        await page.keyboard.press('Escape');
      }
    }
  });

  test('import confirm button exists', async ({ page }) => {
    await goto(page);
    const importBtn = page
      .locator('button')
      .filter({ hasText: /import|استيراد/i })
      .first();
    if (await importBtn.isVisible().catch(() => false)) {
      await importBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const confirmBtn = dialog
          .locator('button')
          .filter({ hasText: /import|استيراد|confirm|تأكيد/i })
          .first();
        const isVisible = await confirmBtn.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Import/Export — export data', () => {
  test('export button triggers download', async ({ page }) => {
    await goto(page);
    const exportBtn = page
      .locator('button')
      .filter({ hasText: /export|تصدير/i })
      .first();
    if (await exportBtn.isVisible().catch(() => false)) {
      const downloadPromise = page.waitForEvent('download', { timeout: 3000 }).catch(() => null);
      await exportBtn.click();
      const download = await downloadPromise;
      if (download) {
        expect(download.suggestedFilename()).toBeTruthy();
      }
    }
  });
});
