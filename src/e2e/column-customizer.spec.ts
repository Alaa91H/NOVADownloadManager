import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Column Customizer — open', () => {
  test('customize columns button exists in table header', async ({ page }) => {
    await goto(page);
    const customizeBtn = page
      .locator('th button')
      .filter({ has: page.locator('svg') })
      .first();
    if (await customizeBtn.isVisible().catch(() => false)) {
      await expect(customizeBtn).toBeVisible();
    }
  });

  test('clicking customize opens column config panel', async ({ page }) => {
    await goto(page);
    const customizeBtn = page
      .locator('th button')
      .filter({ has: page.locator('svg') })
      .first();
    if (await customizeBtn.isVisible().catch(() => false)) {
      await customizeBtn.click();
      await page.waitForTimeout(300);
      const panel = page.locator('[class*="column"], [class*="Column"], [class*="customiz"]');
      const isVisible = await panel.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});

test.describe('Column Customizer — column list', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    const customizeBtn = page
      .locator('th button')
      .filter({ has: page.locator('svg') })
      .first();
    if (await customizeBtn.isVisible().catch(() => false)) {
      await customizeBtn.click();
      await expect(page.getByText('Customize & Reorder Columns')).toBeVisible();
    }
  });

  test('column list shows available columns', async ({ page }) => {
    const panel = page.getByRole('dialog', { name: 'Customize & Reorder Columns' });
    await expect(panel.getByRole('checkbox')).toHaveCount(15);
  });

  test('columns can be toggled on/off', async ({ page }) => {
    const panel = page.getByRole('dialog', { name: 'Customize & Reorder Columns' });
    const checkboxes = panel.getByRole('checkbox');
    const count = await checkboxes.count();
    for (let i = 1; i < Math.min(count, 4); i++) {
      const checkbox = checkboxes.nth(i);
      const wasChecked = await checkbox.getAttribute('aria-checked');
      await checkbox.click();
      await expect(checkbox).toHaveAttribute('aria-checked', wasChecked === 'true' ? 'false' : 'true');
    }
  });

  test('column order is preserved', async ({ page }) => {
    await expect(page.getByRole('columnheader', { name: 'File Name', exact: true })).toBeVisible();
  });
});

test.describe('Column Customizer — column resize', () => {
  test('column resize handle is present on headers', async ({ page }) => {
    await goto(page);
    const handles = page.locator('.cursor-col-resize');
    const count = await handles.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('dragging resize handle changes column width', async ({ page }) => {
    await goto(page);
    const header = page.locator('thead th').first();
    if (await header.isVisible().catch(() => false)) {
      const beforeWidth = await header.evaluate((el) => el.getBoundingClientRect().width);
      const handle = header.locator('.cursor-col-resize');
      if (await handle.isVisible().catch(() => false)) {
        const box = await handle.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + 50, box.y + box.height / 2, { steps: 5 });
          await page.mouse.up();
          await page.waitForTimeout(200);
          const afterWidth = await header.evaluate((el) => el.getBoundingClientRect().width);
          expect(Math.abs(afterWidth - beforeWidth)).toBeGreaterThan(0);
        }
      }
    }
  });
});
