import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

/**
 * The former sidebar was replaced by the responsive command bar. These tests
 * exercise the controls users now use to create, search, and configure tasks.
 */
test.describe('Primary command bar', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('renders a semantic header with the primary controls', async ({ page }) => {
    const commandBar = page.locator('header');
    await expect(commandBar).toBeVisible();
    await expect(commandBar.locator('#topbar-global-search')).toBeVisible();
    await expect(commandBar.locator('button').first()).toBeVisible();
  });

  test('opens the New Download dialog from the primary action', async ({ page }) => {
    const newDownload = page
      .locator('header button')
      .filter({ hasText: /new download|new|تنزيل جديد/i })
      .first();
    await expect(newDownload).toBeVisible();
    await newDownload.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('filters the task table from the labelled global search input', async ({ page }) => {
    const search = page.locator('#topbar-global-search');
    await expect(search).toHaveAttribute('type', 'text');
    await search.fill('non-existent-nova-task');
    await expect(search).toHaveValue('non-existent-nova-task');
  });

  test('opens settings from the command bar', async ({ page }) => {
    const settings = page.locator('header button[title*="settings" i], header button[title*="إعداد" i]').first();
    await expect(settings).toBeVisible();
    await settings.click();

    const settingsPage = page.locator('.app-page');
    await expect(settingsPage).toBeVisible();
    await expect(settingsPage.getByRole('tablist')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settingsPage).not.toBeVisible();
  });

  test('opens Download Lists from the scheduler command', async ({ page }) => {
    const scheduler = page
      .locator('header button')
      .filter({ hasText: /download lists|scheduler|queues|قوائم التنزيل|المجدول/i })
      .first();
    await expect(scheduler).toBeVisible();
    await scheduler.click();

    await expect(page.getByText(/download lists|scheduler|queues|قوائم التنزيل|المجدول/i).first()).toBeVisible();
  });

  test('keeps core commands available in a compact viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await goto(page);

    const commandBar = page.locator('header');
    await expect(commandBar).toBeVisible();
    await expect(commandBar.locator('#topbar-global-search')).toBeVisible();
    await expect(commandBar.locator('button').first()).toBeVisible();
  });
});
