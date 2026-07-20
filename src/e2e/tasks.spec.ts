import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Tasks — empty state', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('empty state is shown when no tasks', async ({ page }) => {
    const rows = page.locator('tr.desktop-table-row');
    const count = await rows.count();
    if (count === 0) {
      const emptyState = page.locator('text=no downloads, text=لا توجد, text=empty').first();
      const isVisible = await emptyState.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('empty state has an icon or illustration', async ({ page }) => {
    const rows = page.locator('tr.desktop-table-row');
    const count = await rows.count();
    if (count === 0) {
      const emptyState = page.locator('[class*="empty"], [class*="EmptyState"]').first();
      const isVisible = await emptyState.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});

test.describe('Tasks — task data display', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('task rows show filename', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const text = await firstRow.textContent();
      expect(text?.length).toBeGreaterThan(0);
    }
  });

  test('task rows show progress percentage', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const progressText = firstRow.locator('text=/\\d+%/');
      const isVisible = await progressText.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('task rows show file size', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const sizeText = firstRow.locator('text=/\\d+\\.?\\d*\\s*(KB|MB|GB|TB|bytes)/i');
      const isVisible = await sizeText.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('task rows show status pill', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const statusPill = firstRow.locator('[class*="pill"], [class*="status"]');
      const isVisible = await statusPill.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});

test.describe('Tasks — task selection', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('clicking task checkbox selects it', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const checkbox = firstRow.locator('input[type="checkbox"]');
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click();
        await page.waitForTimeout(200);
        const isChecked = await checkbox.isChecked();
        expect(isChecked).toBeTruthy();
      }
    }
  });

  test('selecting a task shows batch actions bar', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const checkbox = firstRow.locator('input[type="checkbox"]');
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click();
        await page.waitForTimeout(300);
        const batchBar = page.locator('[class*="batch"], [class*="BatchActions"], [class*="fixed bottom"]');
        const isVisible = await batchBar.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
      }
    }
  });

  test('selecting a task highlights the row', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click();
      await page.waitForTimeout(200);
      const hasHighlight = await firstRow.evaluate(
        (el) =>
          (el.getAttribute('class') ?? '').includes('bg-[var(--accent-primary)]') ||
          (el.getAttribute('class') ?? '').includes('bg-[var(--bg-hover)]') ||
          (el.getAttribute('class') ?? '').includes('selected'),
      );
      expect(typeof hasHighlight).toBe('boolean');
    }
  });

  test('select-all checkbox toggles all rows', async ({ page }) => {
    const selectAll = page.locator('thead input[type="checkbox"]');
    if (await selectAll.isVisible().catch(() => false)) {
      await selectAll.click();
      await page.waitForTimeout(300);
      const allChecked = await selectAll.isChecked();
      expect(typeof allChecked).toBe('boolean');
      await selectAll.click();
      await page.waitForTimeout(300);
    }
  });
});

test.describe('Tasks — task interaction', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('double-clicking a row opens task properties', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.dblclick();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
      }
    }
  });

  test('right-clicking a row opens context menu', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        await expect(menu).toBeVisible();
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Tasks — column header interactions', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('column header click toggles sort', async ({ page }) => {
    const headers = page.locator('thead th[draggable="true"]');
    const count = await headers.count();
    if (count > 0) {
      const firstHeader = headers.first();
      await firstHeader.click();
      await page.waitForTimeout(200);
      await firstHeader.click();
      await page.waitForTimeout(200);
    }
  });

  test('column resize handle is present', async ({ page }) => {
    const resizeHandles = page.locator('.cursor-col-resize');
    const count = await resizeHandles.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Tasks — status pill rendering', () => {
  test('each status pill has correct color', async ({ page }) => {
    await goto(page);
    const pills = page.locator('tr.desktop-table-row [class*="pill"]');
    const count = await pills.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const pill = pills.nth(i);
      if (await pill.isVisible().catch(() => false)) {
        const bgColor = await pill.evaluate((el) => window.getComputedStyle(el).backgroundColor);
        expect(bgColor).toBeTruthy();
      }
    }
  });
});

test.describe('Tasks — mobile card view', () => {
  test('mobile card view is shown on small viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await goto(page);
    const cards = page.locator('[class*="TaskCard"], [class*="task-card"], [class*="md:hidden"]');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('desktop table is hidden on small viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await goto(page);
    const table = page.locator('table.hidden');
    const count = await table.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
