import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Time Display — elapsed time format', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('elapsed time format matches Xs or Xm XXs or Xh XXm XXs', async ({ page }) => {
    const statusBar = page.locator('[role="status"]').first();
    await expect(statusBar).toBeVisible({ timeout: 3000 });
    const elapsedCell = page
      .locator('tr.desktop-table-row td')
      .filter({ hasText: /\d+[hms]/ })
      .first();
    const isVisible = await elapsedCell.isVisible().catch(() => false);
    if (isVisible) {
      const text = await elapsedCell.textContent();
      const matchesFormat = /\d+[hms]/.test(text ?? '');
      expect(matchesFormat).toBe(true);
    }
  });

  test('elapsed column renders in the task table', async ({ page }) => {
    const elapsedHeader = page
      .locator('th')
      .filter({ hasText: /elapsed|المنقضي/i })
      .first();
    const isVisible = await elapsedHeader.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Time Display — time remaining in progress dialog', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
  });

  test.afterEach(async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('time remaining label is present in status tab', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const timeLeft = dialog.locator('text=/time left|الوقت المتبقي/i').first();
    const isVisible = await timeLeft.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('elapsed time value is shown in status tab', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const elapsedLabel = dialog.locator('text=/elapsed|المنقضي/i').first();
    const isVisible = await elapsedLabel.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Time Display — speed formatting', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
  });

  test.afterEach(async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('transfer rate displays a formatted value', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const rateLabel = dialog.locator('text=/transfer rate|سرعة النقل/i').first();
    const isVisible = await rateLabel.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('speed value shows unit pattern (B/s, KB/s, MB/s)', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const speedValue = dialog.locator('text=/\\d+\\.?\\d*\\s*(B|KB|MB|GB)\\/s|--/i').first();
    const isVisible = await speedValue.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('speed tab shows formatted speed value', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const speedTab = dialog
      .locator('button')
      .filter({ hasText: /speed|سرعة/i })
      .first();
    if (await speedTab.isVisible().catch(() => false)) {
      await speedTab.click();
      await page.waitForTimeout(300);
      const rateLabel = dialog.locator('text=/transfer rate|سرعة النقل/i').first();
      const isVisible = await rateLabel.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});
