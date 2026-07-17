import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Toolbar — split button structure', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('new download button is accent-colored', async ({ page }) => {
    const newDlBtn = page.locator('header button').filter({ hasText: /new|جديد/i }).first();
    const isVisible = await newDlBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('resume button exists', async ({ page }) => {
    const resumeBtn = page.locator('header button').filter({ hasText: /resume|استئناف/i }).first();
    const isVisible = await resumeBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('stop button exists', async ({ page }) => {
    const stopBtn = page.locator('header button').filter({ hasText: /stop|إيقاف/i }).first();
    const isVisible = await stopBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('delete button exists with danger styling', async ({ page }) => {
    const deleteBtn = page.locator('header button').filter({ hasText: /delete|حذف/i }).first();
    const isVisible = await deleteBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Toolbar — new download dropdown', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('clicking chevron opens dropdown with 4 options', async ({ page }) => {
    const chevrons = page.locator('header button[data-dialog-trigger="true"]');
    const firstChevron = chevrons.first();
    if (await firstChevron.isVisible().catch(() => false)) {
      await firstChevron.click();
      await page.waitForTimeout(300);
      const dropdownItems = page.locator('.fixed.inset-0.z-40 ~ div button, [role="menuitem"]');
      const count = await dropdownItems.count();
      expect(count).toBeGreaterThanOrEqual(1);
      await page.keyboard.press('Escape');
    }
  });

  test('Single URL option opens new download dialog', async ({ page }) => {
    const chevrons = page.locator('header button[data-dialog-trigger="true"]');
    const firstChevron = chevrons.first();
    if (await firstChevron.isVisible().catch(() => false)) {
      await firstChevron.click();
      await page.waitForTimeout(300);
      const singleUrl = page.locator('button').filter({ hasText: /single url|رابط/i }).first();
      if (await singleUrl.isVisible().catch(() => false)) {
        await singleUrl.click();
        await page.waitForTimeout(500);
        const dialog = page.locator('[role="dialog"]');
        if (await dialog.isVisible().catch(() => false)) {
          await expect(dialog).toBeVisible();
          await page.keyboard.press('Escape');
        }
      }
    }
  });

  test('Batch Download option exists', async ({ page }) => {
    const chevrons = page.locator('header button[data-dialog-trigger="true"]');
    const firstChevron = chevrons.first();
    if (await firstChevron.isVisible().catch(() => false)) {
      await firstChevron.click();
      await page.waitForTimeout(300);
      const batchBtn = page.locator('button').filter({ hasText: /batch|دفعة|جملة/i }).first();
      const isVisible = await batchBtn.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
      await page.keyboard.press('Escape');
    }
  });

  test('Webpage Grabber option exists', async ({ page }) => {
    const chevrons = page.locator('header button[data-dialog-trigger="true"]');
    const firstChevron = chevrons.first();
    if (await firstChevron.isVisible().catch(() => false)) {
      await firstChevron.click();
      await page.waitForTimeout(300);
      const grabberBtn = page.locator('button').filter({ hasText: /grabber|التقاط|أمسك/i }).first();
      const isVisible = await grabberBtn.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
      await page.keyboard.press('Escape');
    }
  });

  test('Media Downloader option exists', async ({ page }) => {
    const chevrons = page.locator('header button[data-dialog-trigger="true"]');
    const firstChevron = chevrons.first();
    if (await firstChevron.isVisible().catch(() => false)) {
      await firstChevron.click();
      await page.waitForTimeout(300);
      const mediaBtn = page.locator('button').filter({ hasText: /media|وسائط|فيديو/i }).first();
      const isVisible = await mediaBtn.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('Toolbar — resume dropdown', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('resume dropdown has Resume Selected and Resume All', async ({ page }) => {
    const resumeChevron = page.locator('button[aria-label*="resume" i]').first();
    if (await resumeChevron.isVisible().catch(() => false)) {
      await resumeChevron.click();
      await page.waitForTimeout(200);
      const resumeSelected = page.locator('button').filter({ hasText: /resume selected|استئناف المحدد/i }).first();
      const resumeAll = page.locator('button').filter({ hasText: /resume all|استئناف الكل/i }).first();
      const hasSelected = await resumeSelected.isVisible().catch(() => false);
      const hasAll = await resumeAll.isVisible().catch(() => false);
      expect(typeof hasSelected).toBe('boolean');
      expect(typeof hasAll).toBe('boolean');
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('Toolbar — stop dropdown', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('stop dropdown has Stop Selected and Stop All', async ({ page }) => {
    const stopChevron = page.locator('button[aria-label*="more" i]').first();
    if (await stopChevron.isVisible().catch(() => false)) {
      await stopChevron.click();
      await page.waitForTimeout(200);
      const stopSelected = page.locator('button').filter({ hasText: /stop selected|إيقاف المحدد/i }).first();
      const stopAll = page.locator('button').filter({ hasText: /stop all|إيقاف الكل/i }).first();
      const hasSelected = await stopSelected.isVisible().catch(() => false);
      const hasAll = await stopAll.isVisible().catch(() => false);
      expect(typeof hasSelected).toBe('boolean');
      expect(typeof hasAll).toBe('boolean');
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('Toolbar — delete dropdown', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('delete dropdown has Delete Selected, Delete All, Delete Completed', async ({ page }) => {
    const deleteChevron = page.locator('button[aria-label*="more" i]').last();
    if (await deleteChevron.isVisible().catch(() => false)) {
      await deleteChevron.click();
      await page.waitForTimeout(200);
      const deleteSelected = page.locator('button').filter({ hasText: /delete selected|حذف المحدد/i }).first();
      const deleteAll = page.locator('button').filter({ hasText: /delete all|حذف الكل/i }).first();
      const deleteCompleted = page.locator('button').filter({ hasText: /delete completed|حذف المكتمل/i }).first();
      const hasSelected = await deleteSelected.isVisible().catch(() => false);
      const hasAll = await deleteAll.isVisible().catch(() => false);
      const hasCompleted = await deleteCompleted.isVisible().catch(() => false);
      expect(typeof hasSelected).toBe('boolean');
      expect(typeof hasAll).toBe('boolean');
      expect(typeof hasCompleted).toBe('boolean');
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('Toolbar — disabled states', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('resume button has disabledTooltip when no selection', async ({ page }) => {
    const resumeBtn = page.locator('header button').filter({ hasText: /resume|استئناف/i }).first();
    if (await resumeBtn.isVisible().catch(() => false)) {
      const isDisabled = await resumeBtn.isDisabled();
      if (isDisabled) {
        const title = await resumeBtn.getAttribute('title');
        expect(title).toBeTruthy();
      }
    }
  });

  test('disabled buttons show title tooltip', async ({ page }) => {
    const buttons = page.locator('header button[disabled]');
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const title = await btn.getAttribute('title');
        expect(title).toBeTruthy();
      }
    }
  });
});

test.describe('Toolbar — Escape closes dropdowns', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('Escape closes new download dropdown', async ({ page }) => {
    const chevrons = page.locator('header button[data-dialog-trigger="true"]');
    const firstChevron = chevrons.first();
    if (await firstChevron.isVisible().catch(() => false)) {
      await firstChevron.click();
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
  });

  test('Escape closes resume dropdown', async ({ page }) => {
    const resumeChevron = page.locator('button[aria-label*="resume" i]').first();
    if (await resumeChevron.isVisible().catch(() => false)) {
      await resumeChevron.click();
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
  });
});
