import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('UI Responsive — command bar layout', () => {
  test('desktop layout keeps the task table and command bar visible', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await goto(page);
    await expect(page.locator('header')).toBeVisible();
    await expect(page.locator('table')).toBeVisible();
    await expect(page.locator('#topbar-global-search')).toBeVisible();
  });

  test('compact layout keeps the new-download control and search reachable', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await goto(page);
    const header = page.locator('header');
    await expect(header).toBeVisible();
    await expect(header.locator('button').first()).toBeVisible();
    await expect(page.locator('#topbar-global-search')).toBeVisible();
  });

  test('reflows from desktop to compact width without losing the command bar', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await goto(page);
    await expect(page.locator('header')).toBeVisible();
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.locator('header')).toBeVisible();
    await expect(page.locator('#topbar-global-search')).toBeVisible();
  });

  test('does not create document-level horizontal scrolling on wide screens', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await goto(page);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true);
  });
});

test.describe('UI Responsive — keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('Ctrl+N opens the New Download dialog', async ({ page }) => {
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('Ctrl+L opens Download Lists', async ({ page }) => {
    await page.keyboard.press('Control+l');
    await expect(page.getByText(/download lists|scheduler|queues|قوائم التنزيل|المجدول/i).first()).toBeVisible();
  });

  test('Ctrl+, opens Settings', async ({ page }) => {
    await page.keyboard.press('Control+,');
    const settingsPage = page.locator('.app-page');
    await expect(settingsPage.getByRole('tablist')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settingsPage).not.toBeVisible();
  });

  test('Ctrl+F focuses the global search input', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await expect(page.locator('#topbar-global-search')).toBeFocused();
  });

  test('shortcuts do not navigate while the search input is edited', async ({ page }) => {
    const search = page.locator('#topbar-global-search');
    await search.fill('test query');
    await page.keyboard.press('Control+l');
    await expect(page.locator('.app-page')).toHaveCount(0);
  });
});

test.describe('UI Responsive — drag and design-system contracts', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('column headers remain draggable for reordering', async ({ page }) => {
    const headers = page.locator('thead th[draggable="true"]');
    await expect(headers.first()).toBeVisible();
    expect(await headers.count()).toBeGreaterThanOrEqual(1);
  });

  test('defines core CSS variables on the root element', async ({ page }) => {
    const values = await page.evaluate(() => {
      const style = window.getComputedStyle(document.documentElement);
      return [
        style.getPropertyValue('--bg-app'),
        style.getPropertyValue('--accent-primary'),
        style.getPropertyValue('--text-primary'),
      ];
    });
    values.forEach((value) => {
      expect(value.trim()).toBeTruthy();
    });
  });

  test('reduces animation and transition duration when the OS requests it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    const timing = await dialog.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return [style.animationDuration, style.transitionDuration].map((value) => Number.parseFloat(value));
    });
    timing.forEach((durationSeconds) => {
      expect(durationSeconds).toBeLessThanOrEqual(0.001);
    });
    await page.keyboard.press('Escape');
  });
});

test.describe('UI Responsive — status summary', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('shows the dedicated status bar in every supported layout', async ({ page }) => {
    const statusBar = page.getByTestId('status-bar');
    await expect(statusBar).toBeVisible();
    await expect(statusBar).toContainText(/\d/);
  });

  test('keeps status controls available', async ({ page }) => {
    const controls = page.getByTestId('status-bar').locator('button');
    await expect(controls.first()).toBeVisible();
  });
});
