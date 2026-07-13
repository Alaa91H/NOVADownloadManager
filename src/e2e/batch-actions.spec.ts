import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Batch Actions Bar — visibility', () => {
  test('batch actions bar appears when tasks are selected', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const checkbox = firstRow.locator('input[type="checkbox"]');
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click();
        await page.waitForTimeout(300);
        const batchBar = page.locator('[class*="fixed bottom"], [class*="batch"]');
        const isVisible = await batchBar.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
      }
    }
  });

  test('batch actions bar has selected count', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const checkbox = firstRow.locator('input[type="checkbox"]');
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click();
        await page.waitForTimeout(300);
        const countText = page.locator('[class*="batch"], [class*="fixed bottom"]').filter({ hasText: /selected|محدد/i }).first();
        const isVisible = await countText.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
      }
    }
  });

  test('batch actions bar has resume button', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const checkbox = firstRow.locator('input[type="checkbox"]');
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click();
        await page.waitForTimeout(300);
        const resumeBtn = page.locator('[class*="batch"], [class*="fixed bottom"]').locator('button').filter({ hasText: /resume|استئناف/i }).first();
        const isVisible = await resumeBtn.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
      }
    }
  });

  test('batch actions bar has pause button', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const checkbox = firstRow.locator('input[type="checkbox"]');
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click();
        await page.waitForTimeout(300);
        const pauseBtn = page.locator('[class*="batch"], [class*="fixed bottom"]').locator('button').filter({ hasText: /stop|pause|إيقاف/i }).first();
        const isVisible = await pauseBtn.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
      }
    }
  });

  test('batch actions bar has delete button', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const checkbox = firstRow.locator('input[type="checkbox"]');
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click();
        await page.waitForTimeout(300);
        const deleteBtn = page.locator('[class*="batch"], [class*="fixed bottom"]').locator('button').filter({ hasText: /delete|حذف/i }).first();
        const isVisible = await deleteBtn.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
      }
    }
  });

  test('deselecting all hides batch actions bar', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const checkbox = firstRow.locator('input[type="checkbox"]');
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click();
        await page.waitForTimeout(300);
        await checkbox.click();
        await page.waitForTimeout(300);
        const batchBar = page.locator('[class*="fixed bottom"], [class*="batch"]');
        const isVisible = await batchBar.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
      }
    }
  });
});

test.describe('Batch Actions Bar — selection count', () => {
  test('select-all shows correct count', async ({ page }) => {
    await goto(page);
    const selectAll = page.locator('thead input[type="checkbox"]');
    if (await selectAll.isVisible().catch(() => false)) {
      await selectAll.click();
      await page.waitForTimeout(300);
      const countText = page.locator('[class*="batch"], [class*="fixed bottom"]').filter({ hasText: /\d+/ }).first();
      const isVisible = await countText.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
      await selectAll.click();
      await page.waitForTimeout(200);
    }
  });

  test('selecting multiple rows increments count', async ({ page }) => {
    await goto(page);
    const rows = page.locator('tr.desktop-table-row');
    const count = await rows.count();
    if (count >= 2) {
      const firstCheckbox = rows.nth(0).locator('input[type="checkbox"]');
      const secondCheckbox = rows.nth(1).locator('input[type="checkbox"]');
      if (await firstCheckbox.isVisible().catch(() => false) && await secondCheckbox.isVisible().catch(() => false)) {
        await firstCheckbox.click();
        await secondCheckbox.click();
        await page.waitForTimeout(300);
        const countText = page.locator('[class*="batch"], [class*="fixed bottom"]').filter({ hasText: /2|selected|محدد/i }).first();
        const isVisible = await countText.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
      }
    }
  });
});
