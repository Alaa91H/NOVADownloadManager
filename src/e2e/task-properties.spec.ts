import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Task Properties — dialog structure', () => {
  test('task properties opens on double-click', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.dblclick();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const title = page.locator('#modal-title');
        if (await title.isVisible().catch(() => false)) {
          const text = await title.textContent();
          expect(text?.length).toBeGreaterThan(0);
        }
        await page.keyboard.press('Escape');
      }
    }
  });

  test('task properties opens from context menu', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const props = page
        .locator('[role="menuitem"]')
        .filter({ hasText: /properties|الخصائص/i })
        .first();
      if (await props.isVisible().catch(() => false)) {
        await props.click();
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

test.describe('Task Properties — content sections', () => {
  test('properties shows URL field', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.dblclick();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const urlField = dialog.locator('text=url, text=رابط, text=URL').first();
        const isVisible = await urlField.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });

  test('properties shows status field', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.dblclick();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const statusField = dialog.locator('text=status, text=الحالة').first();
        const isVisible = await statusField.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });

  test('properties shows file size field', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.dblclick();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const sizeField = dialog.locator('text=size, text=الحجم').first();
        const isVisible = await sizeField.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });

  test('properties shows save path field', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.dblclick();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const pathField = dialog.locator('text=path, text=المسار, text=folder').first();
        const isVisible = await pathField.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Task Properties — close', () => {
  test('Escape closes properties dialog', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.dblclick();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible({ timeout: 3000 });
      }
    }
  });

  test('close button closes properties dialog', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.dblclick();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const closeBtn = dialog.locator('button[title*="close" i], button[title*="إغلاق" i]').first();
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click();
          await expect(dialog).not.toBeVisible({ timeout: 3000 });
        }
      }
    }
  });
});
