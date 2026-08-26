import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

const seedContextMenuTask = async (page: import('@playwright/test').Page) => {
  await page.evaluate(async () => {
    const storeUrl = '/src/store/taskStore.ts';
    const mod = (await import(storeUrl)) as {
      taskStore: { getState: () => { setTasks: (tasks: unknown[]) => void } };
    };
    mod.taskStore.getState().setTasks([
      {
        id: 'context-menu-a11y-e2e',
        name: 'context-menu-fixture.zip',
        url: 'https://example.com/context-menu-fixture.zip',
        fileType: 'compressed',
        status: 'paused',
        sizeBytes: 1024,
        downloadedBytes: 0,
        speedBytesPerSec: 0,
        timeLeftSeconds: 0,
        elapsedSeconds: 0,
        dateAdded: '2024-01-01T00:00:00.000Z',
        category: 'other',
        queueId: 'main',
        connections: 1,
        resumable: true,
        savePath: '/tmp/context-menu-fixture.zip',
        description: '',
        segments: [],
      },
    ]);
  });
  await expect(page.locator('tr.desktop-table-row').first()).toBeVisible();
};

test.describe('Theme — design tokens', () => {
  test('defines the core color tokens on the document root', async ({ page }) => {
    await goto(page);
    const tokens = await page.evaluate(() => {
      const style = window.getComputedStyle(document.documentElement);
      return ['--bg-app', '--bg-surface', '--accent-primary', '--text-primary'].map((name) => [
        name,
        style.getPropertyValue(name).trim(),
      ]);
    });

    for (const [, value] of tokens) {
      expect(value).toBeTruthy();
    }
  });

  test('uses a resolved background color for the application shell', async ({ page }) => {
    await goto(page);
    const background = await page.locator('#root').evaluate((root) => window.getComputedStyle(root).backgroundColor);
    expect(background).not.toBe('');
  });

  test('keeps theme configuration discoverable in Settings', async ({ page }) => {
    await goto(page);
    const settings = page.locator('header button[title*="settings" i], header button[title*="إعداد" i]').first();
    await settings.click();
    const settingsPage = page.locator('.app-page');
    await expect(settingsPage).toBeVisible();
    await expect(settingsPage.getByRole('tablist')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

test.describe('Theme — reduced motion', () => {
  test('applies the operating-system reduced-motion policy to dialogs', async ({ page }) => {
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

test.describe('Accessibility — keyboard and ARIA contracts', () => {
  test('uses correct dialog labelling and modality', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const titleId = await dialog.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    await expect(dialog.getByRole('heading')).toHaveAttribute('id', titleId!);
    await page.keyboard.press('Escape');
  });

  test('keeps the primary action reachable by keyboard', async ({ page }) => {
    await goto(page);
    const newDownload = page
      .locator('header button')
      .filter({ hasText: /new download|new|تنزيل جديد/i })
      .first();
    await newDownload.focus();
    await expect(newDownload).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('uses an explicit live region for transient notifications', async ({ page }) => {
    await goto(page);
    const liveRegion = page.locator('[aria-live="polite"]');
    // An empty notification stack has no layout box, but it must remain in the
    // accessibility tree so future toast text is announced without remounting.
    await expect(liveRegion).toBeAttached();
    await expect(liveRegion).toHaveAttribute('role', 'status');
    await expect(liveRegion).toHaveAttribute('aria-live', 'polite');
  });

  test('uses menu and menuitem roles for a task context menu', async ({ page }) => {
    await goto(page);
    await seedContextMenuTask(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    await expect(firstRow).toBeVisible();
    await firstRow.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
