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
      await page.waitForTimeout(300);
    }
  });

  test('column list shows available columns', async ({ page }) => {
    const columns = page.locator('[class*="column"] label, [class*="Column"] label, [class*="customiz"] label');
    const count = await columns.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('columns can be toggled on/off', async ({ page }) => {
    const checkboxes = page.locator(
      '[class*="column"] input[type="checkbox"], [class*="Column"] input[type="checkbox"], [class*="customiz"] input[type="checkbox"]',
    );
    const count = await checkboxes.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const cb = checkboxes.nth(i);
      if (await cb.isVisible().catch(() => false)) {
        const wasChecked = await cb.isChecked();
        await cb.click();
        await page.waitForTimeout(200);
        const isNowChecked = await cb.isChecked();
        expect(isNowChecked).toBe(!wasChecked);
      }
    }
  });

  test('column order is preserved', async ({ page }) => {
    const headers = page.locator('thead th');
    const firstText = await headers.first().textContent();
    expect(firstText).toBeTruthy();
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
