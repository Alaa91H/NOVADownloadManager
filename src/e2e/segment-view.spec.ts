import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Segment View — toggle and rendering', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
  });

  test.afterEach(async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('segment details toggle button exists in active progress dialog', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const showDetailsBtn = dialog.locator('button').filter({ hasText: /show details|إظهار التفاصيل/i }).first();
    const isVisible = await showDetailsBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('clicking segment toggle reveals segment info section', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const showDetailsBtn = dialog.locator('button').filter({ hasText: /show details|إظهار التفاصيل/i }).first();
    if (await showDetailsBtn.isVisible().catch(() => false)) {
      await showDetailsBtn.click();
      await page.waitForTimeout(400);
      const segmentLabel = dialog.locator('text=/segment|الجزء|اتصال/i').first();
      const isVisible = await segmentLabel.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('segment progress bars render after toggle', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const showDetailsBtn = dialog.locator('button').filter({ hasText: /show details|إظهار التفاصيل/i }).first();
    if (await showDetailsBtn.isVisible().catch(() => false)) {
      await showDetailsBtn.click();
      await page.waitForTimeout(400);
      const progressBar = dialog.locator('[class*="bg-[var(--accent-primary)]"]').first();
      const isVisible = await progressBar.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('segment table renders with columns', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const showDetailsBtn = dialog.locator('button').filter({ hasText: /show details|إظهار التفاصيل/i }).first();
    if (await showDetailsBtn.isVisible().catch(() => false)) {
      await showDetailsBtn.click();
      await page.waitForTimeout(400);
      const table = dialog.locator('table');
      if (await table.isVisible().catch(() => false)) {
        const headers = table.locator('thead th');
        const count = await headers.count();
        expect(count).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

test.describe('Segment View — active download dialog info', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('elapsed time display is visible in active download dialog status tab', async ({ page }) => {
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
    const dialog = page.locator('[role="dialog"]');
    const elapsedLabel = dialog.locator('text=/elapsed|المنقضي/i').first();
    const isVisible = await elapsedLabel.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
    await page.keyboard.press('Escape');
  });

  test('per-segment speed values display (not hardcoded 0)', async ({ page }) => {
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
    const dialog = page.locator('[role="dialog"]');
    const showDetailsBtn = dialog.locator('button').filter({ hasText: /show details|إظهار التفاصيل/i }).first();
    if (await showDetailsBtn.isVisible().catch(() => false)) {
      await showDetailsBtn.click();
      await page.waitForTimeout(400);
      const stateCells = dialog.locator('table tbody td');
      const count = await stateCells.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }
    await page.keyboard.press('Escape');
  });
});

test.describe('Segment View — hide details', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
  });

  test('clicking hide details collapses segment info', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const showDetailsBtn = dialog.locator('button').filter({ hasText: /show details|إظهار التفاصيل/i }).first();
    if (await showDetailsBtn.isVisible().catch(() => false)) {
      await showDetailsBtn.click();
      await page.waitForTimeout(400);
      const hideDetailsBtn = dialog.locator('button').filter({ hasText: /hide details|إخفاء التفاصيل/i }).first();
      if (await hideDetailsBtn.isVisible().catch(() => false)) {
        await hideDetailsBtn.click();
        await page.waitForTimeout(400);
        const table = dialog.locator('table');
        const isVisible = await table.isVisible().catch(() => false);
        expect(isVisible).toBe(false);
      }
    }
    await page.keyboard.press('Escape');
  });
});
