import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

const speedLimiter = (page: import('@playwright/test').Page) =>
  page.getByTestId('status-bar').locator('button[title*="speed" i], button[title*="سرعة" i]').first();

test.describe('Status Bar — live download summary', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('renders the dedicated status bar', async ({ page }) => {
    const statusBar = page.getByTestId('status-bar');
    await expect(statusBar).toBeVisible();
    await expect(statusBar).toContainText(/\d/);
  });

  test('exposes a daemon-health action with an accessible tooltip', async ({ page }) => {
    const daemonButton = page.getByTestId('status-bar').locator('button[title]').first();
    await expect(daemonButton).toBeVisible();
    await expect(daemonButton).toHaveAttribute('title', /.+/);
    await daemonButton.click();
    await expect(page.locator('[role="status"]')).toContainText(/service|daemon|connected|خدمة/i);
  });
});

test.describe('Status Bar — speed limiter', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('opens the limiter menu with documented presets', async ({ page }) => {
    const limiter = speedLimiter(page);
    await expect(limiter).toBeVisible();
    await limiter.click();

    const presetButtons = page.getByRole('button', { name: /500 KB\/s|1 MB\/s|2 MB\/s|5 MB\/s|10 MB\/s|20 MB\/s/i });
    await expect(presetButtons.first()).toBeVisible();
    await expect(presetButtons).toHaveCount(6);
    await page.keyboard.press('Escape');
  });

  test('reveals a numeric custom-speed input when requested', async ({ page }) => {
    await speedLimiter(page).click();
    const custom = page.getByRole('button', { name: /set custom speed|تعيين سرعة مخصصة/i });
    await expect(custom).toBeVisible();
    await custom.click();
    await expect(page.locator('input[type="number"]')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('allows a documented preset to be applied', async ({ page }) => {
    await speedLimiter(page).click();
    const preset = page.getByRole('button', { name: '1 MB/s', exact: true });
    await expect(preset).toBeVisible();
    await preset.click();
    await expect(page.getByRole('button', { name: '1 MB/s', exact: true })).toHaveCount(0);
  });
});

test.describe('Status Bar — optional controls', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('provides a clipboard monitor toggle when the control is enabled', async ({ page }) => {
    const clipboard = page
      .getByTestId('status-bar')
      .locator('button[title*="clipboard" i], button[title*="حافظة" i]')
      .first();
    await expect(clipboard).toBeVisible();
    await expect(clipboard).toHaveAttribute('title', /.+/);
  });

  test('provides a notification control with an accessible tooltip', async ({ page }) => {
    const notifications = page
      .getByTestId('status-bar')
      .locator('button[title*="notification" i], button[title*="إشعار" i]')
      .first();
    await expect(notifications).toBeVisible();
    await expect(notifications).toHaveAttribute('title', /.+/);
  });
});
