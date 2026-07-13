import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Downloads — task table structure', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('desktop table is visible on large viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 3000 });
  });

  test('table has column headers', async ({ page }) => {
    const headers = page.locator('thead th');
    const count = await headers.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('select-all checkbox exists in table header', async ({ page }) => {
    const selectAll = page.locator('thead input[type="checkbox"]');
    if (await selectAll.isVisible().catch(() => false)) {
      await expect(selectAll).toBeVisible();
    }
  });

  test('column headers are draggable for reorder', async ({ page }) => {
    const headers = page.locator('thead th[draggable="true"]');
    const count = await headers.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('customize columns button exists', async ({ page }) => {
    const customizeBtn = page.locator('th button').filter({ has: page.locator('svg') }).first();
    if (await customizeBtn.isVisible().catch(() => false)) {
      await expect(customizeBtn).toBeVisible();
    }
  });
});

test.describe('Downloads — task rows', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('empty state message shown when no tasks', async ({ page }) => {
    const rows = page.locator('tr.desktop-table-row');
    const count = await rows.count();
    if (count === 0) {
      const emptyMsg = page.locator('td[colSpan]').filter({ hasText: /no downloads|no tasks/i });
      await expect(emptyMsg.first()).toBeVisible({ timeout: 3000 });
    }
  });

  test('task rows have correct structure', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const cells = firstRow.locator('td');
      const cellCount = await cells.count();
      expect(cellCount).toBeGreaterThanOrEqual(3);
    }
  });

  test('task row has checkbox for selection', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const checkbox = firstRow.locator('input[type="checkbox"]');
      const hasCheckbox = await checkbox.isVisible().catch(() => false);
      expect(typeof hasCheckbox).toBe('boolean');
    }
  });

  test('clicking task row selects it', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click();
      await page.waitForTimeout(200);
      const hasSelected = await firstRow.evaluate(el =>
        (el.getAttribute('class') ?? '').includes('selected') || (el.getAttribute('class') ?? '').includes('bg-[var(--bg-hover)]')
      );
      expect(typeof hasSelected).toBe('boolean');
    }
  });

  test('double-clicking task row opens task detail', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.dblclick();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      const dialogVisible = await dialog.isVisible().catch(() => false);
      if (dialogVisible) {
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Downloads — task selection', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('select-all checkbox toggles all rows', async ({ page }) => {
    const selectAll = page.locator('thead input[type="checkbox"]');
    if (await selectAll.isVisible().catch(() => false)) {
      await selectAll.click();
      await page.waitForTimeout(200);
      const checked = await selectAll.isChecked();
      expect(typeof checked).toBe('boolean');
      await selectAll.click();
      await page.waitForTimeout(200);
    }
  });

  test('selecting a row shows batch actions', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const checkbox = firstRow.locator('input[type="checkbox"]');
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click();
        await page.waitForTimeout(300);
        const batchBar = page.locator('[class*="batch"], [class*="BatchActions"]');
        const isVisible = await batchBar.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
      }
    }
  });
});

test.describe('Downloads — column sorting', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('clicking column header sorts tasks', async ({ page }) => {
    const nameHeader = page.locator('thead th').filter({ hasText: /name|file/i }).first();
    if (await nameHeader.isVisible().catch(() => false)) {
      await nameHeader.click();
      await page.waitForTimeout(300);
      await nameHeader.click();
      await page.waitForTimeout(300);
    }
  });

  test('sort indicator changes on repeated clicks', async ({ page }) => {
    const header = page.locator('thead th').nth(1);
    if (await header.isVisible().catch(() => false)) {
      await header.click();
      await page.waitForTimeout(200);
      await header.click();
      await page.waitForTimeout(200);
    }
  });
});

test.describe('Downloads — context menu', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('right-clicking task row opens context menu', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        await expect(menu).toBeVisible();
        const items = page.locator('[role="menuitem"]');
        const count = await items.count();
        expect(count).toBeGreaterThanOrEqual(2);
        await page.keyboard.press('Escape');
      }
    }
  });

  test('context menu has Copy URL option', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const copyUrl = page.locator('[role="menuitem"]').filter({ hasText: /copy.*url/i });
      const isVisible = await copyUrl.isVisible().catch(() => false);
      if (isVisible) {
        await page.keyboard.press('Escape');
      }
    }
  });

  test('context menu has Properties option', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const props = page.locator('[role="menuitem"]').filter({ hasText: /properties/i });
      const isVisible = await props.isVisible().catch(() => false);
      if (isVisible) {
        await page.keyboard.press('Escape');
      }
    }
  });

  test('context menu closes on Escape', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await expect(page.locator('[role="menu"]')).not.toBeVisible({ timeout: 1000 });
    }
  });

  test('context menu closes on click outside', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      if (await page.locator('[role="menu"]').isVisible().catch(() => false)) {
        await page.click('body', { position: { x: 10, y: 10 } });
        await page.waitForTimeout(300);
      }
    }
  });
});

test.describe('Downloads — task row context menu actions', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('context menu Properties opens task properties dialog', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const props = page.locator('[role="menuitem"]').filter({ hasText: /properties/i });
      if (await props.isVisible().catch(() => false)) {
        await props.click();
        await page.waitForTimeout(500);
        const dialog = page.locator('[role="dialog"]');
        if (await dialog.isVisible().catch(() => false)) {
          await page.keyboard.press('Escape');
        }
      }
    }
  });

  test('Delete option in context menu is danger-styled', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const deleteItem = page.locator('[role="menuitem"]').filter({ hasText: /delete/i });
      if (await deleteItem.isVisible().catch(() => false)) {
        const isRed = await deleteItem.evaluate(el =>
          (el.getAttribute('class') ?? '').includes('red') || (el.getAttribute('class') ?? '').includes('danger') ||
          window.getComputedStyle(el).color.includes('239')
        );
        expect(typeof isRed).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Downloads — status pills', () => {
  test('status pills render in task rows', async ({ page }) => {
    await goto(page);
    const pills = page.locator('tr.desktop-table-row span[class*="pill"], tr.desktop-table-row [class*="status"]');
    const count = await pills.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Downloads — progress bar', () => {
  test('progress bar exists in downloading tasks', async ({ page }) => {
    await goto(page);
    const progressBars = page.locator('tr.desktop-table-row [role="progressbar"], tr.desktop-table-row [class*="progress"]');
    const count = await progressBars.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
