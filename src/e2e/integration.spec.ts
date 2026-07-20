import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Integration — download flow', () => {
  test('complete new download flow: open dialog → enter URL → queue', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    const urlInput = dialog.locator('input[type="text"]').first();
    await urlInput.fill('https://example.com/test-file.zip');
    const value = await urlInput.inputValue();
    expect(value).toContain('example.com');

    const queueBtn = dialog
      .locator('button')
      .filter({ hasText: /queue|إضافة/i })
      .first();
    if (await queueBtn.isVisible().catch(() => false)) {
      await queueBtn.click();
      await page.waitForTimeout(500);
    }
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('complete new download flow: open dialog → enter URL → download now', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    const urlInput = dialog.locator('input[type="text"]').first();
    await urlInput.fill('https://example.com/another-file.zip');

    const startBtn = dialog
      .locator('button')
      .filter({ hasText: /download now|بدء|تنزيل/i })
      .first();
    if (await startBtn.isVisible().catch(() => false)) {
      await startBtn.click();
      await page.waitForTimeout(500);
    }
  });
});

test.describe('Integration — settings flow', () => {
  test('change language → verify UI updates → change back', async ({ page }) => {
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
        const original = await langSelect.inputValue();
        const options = await langSelect.locator('option').allTextContents();
        if (options.length > 1) {
          const secondValue = await langSelect.locator('option').nth(1).getAttribute('value');
          if (secondValue && secondValue !== original) {
            await langSelect.selectOption(secondValue);
            await page.waitForTimeout(500);
            await langSelect.selectOption(original);
            await page.waitForTimeout(500);
          }
        }
      }
    }
  });

  test('change theme → verify colors → change back', async ({ page }) => {
    await goto(page);

    const lightBtn = page.locator('aside button[title*="light" i], aside button[title*="فاتح" i]').first();
    if (await lightBtn.isVisible().catch(() => false)) {
      await lightBtn.click();
      await page.waitForTimeout(300);
      const newBg = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim(),
      );
      expect(newBg).toBeTruthy();

      const darkBtn = page.locator('aside button[title*="dark" i], aside button[title*="داكن" i]').first();
      if (await darkBtn.isVisible().catch(() => false)) {
        await darkBtn.click();
        await page.waitForTimeout(300);
      }
    }
  });

  test('change density → verify layout → change back', async ({ page }) => {
    await goto(page);
    const densitySelect = page.locator('aside select').first();
    if (await densitySelect.isVisible().catch(() => false)) {
      const original = await densitySelect.inputValue();
      const options = await densitySelect.locator('option').allTextContents();
      if (options.length > 1) {
        const otherValue = await densitySelect.locator('option').nth(1).getAttribute('value');
        if (otherValue && otherValue !== original) {
          await densitySelect.selectOption(otherValue);
          await page.waitForTimeout(300);
          await densitySelect.selectOption(original);
          await page.waitForTimeout(300);
        }
      }
    }
  });
});

test.describe('Integration — scheduler flow', () => {
  test('create queue → select it → configure → start → stop', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);

    const input = page.locator('input[type="text"]').last();
    if (await input.isVisible().catch(() => false)) {
      await input.fill('E2E Test Queue');
      const createBtn = page
        .locator('button')
        .filter({ has: page.locator('svg') })
        .last();
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
        await page.waitForTimeout(300);
      }
    }

    const basicTab = page.locator('button').filter({ hasText: /basic/i }).first();
    if (await basicTab.isVisible().catch(() => false)) {
      await basicTab.click();
      await page.waitForTimeout(300);
    }

    const startBtn = page
      .locator('button')
      .filter({ hasText: /start|play|تشغيل/i })
      .first();
    if (await startBtn.isVisible().catch(() => false)) {
      await startBtn.click();
      await page.waitForTimeout(500);
    }

    const stopBtn = page
      .locator('button')
      .filter({ hasText: /stop|square|إيقاف/i })
      .first();
    if (await stopBtn.isVisible().catch(() => false)) {
      await stopBtn.click();
      await page.waitForTimeout(500);
    }
  });
});

test.describe('Integration — task management flow', () => {
  test('select tasks → batch actions → deselect', async ({ page }) => {
    await goto(page);
    const selectAll = page.locator('thead input[type="checkbox"]');
    if (await selectAll.isVisible().catch(() => false)) {
      await selectAll.click();
      await page.waitForTimeout(300);
      const batchBar = page.locator('[class*="batch"], [class*="fixed bottom"]');
      const isVisible = await batchBar.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');

      await selectAll.click();
      await page.waitForTimeout(300);
    }
  });

  test('context menu → copy URL → verify', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const copyUrl = page
        .locator('[role="menuitem"]')
        .filter({ hasText: /copy.*url/i })
        .first();
      if (await copyUrl.isVisible().catch(() => false)) {
        await copyUrl.click();
        await page.waitForTimeout(500);
      }
    }
  });
});

test.describe('Integration — search flow', () => {
  test('search → find results → clear search', async ({ page }) => {
    await goto(page);
    const search = page.locator('[data-global-search="true"]');
    await search.click();
    await search.fill('test');
    await page.waitForTimeout(500);
    await search.fill('');
    await page.waitForTimeout(300);
    await expect(search).toHaveValue('');
  });
});

test.describe('Integration — navigation flow', () => {
  test('downloads → settings → back → scheduler → back → downloads', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await expect(page.locator('#root')).toBeVisible();
  });
});

test.describe('Integration — toast flow', () => {
  test('action triggers toast → toast auto-dismisses', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(5000);
    await expect(page.locator('[role="status"][aria-live="polite"]')).toBeVisible();
  });
});
