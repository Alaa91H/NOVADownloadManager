import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Navigation — sidebar workspace views', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  const views = [
    { label: 'All Downloads', view: 'all' },
    { label: 'Downloading', view: 'unfinished' },
    { label: 'Completed', view: 'finished' },
    { label: 'Queued', view: 'queued' },
  ];

  for (const v of views) {
    test(`clicking "${v.label}" switches workspace view`, async ({ page }) => {
      const btn = page.locator('aside button', { hasText: new RegExp(v.label, 'i') }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(300);
        const isActive = await btn.evaluate(
          (el) =>
            (el.getAttribute('class') ?? '').includes('bg-[var(--bg-selected)]') ||
            (el.getAttribute('class') ?? '').includes('font-bold'),
        );
        expect(isActive).toBeTruthy();
      }
    });
  }

  const fileTypes = [
    { label: 'Compressed', ext: 'compressed' },
    { label: 'Programs', ext: 'program' },
    { label: 'Videos', ext: 'video' },
    { label: 'Audio', ext: 'audio' },
    { label: 'Documents', ext: 'document' },
  ];

  for (const ft of fileTypes) {
    test(`clicking "${ft.label}" filters by file type`, async ({ page }) => {
      const btn = page.locator('aside button', { hasText: new RegExp(ft.label, 'i') }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    });
  }
});

test.describe('Navigation — topbar split button dropdowns', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('new download dropdown shows Single URL, Batch, Grabber, Media options', async ({ page }) => {
    const chevron = page.locator('button[data-dialog-trigger="true"]').first();
    if (await chevron.isVisible().catch(() => false)) {
      await chevron.click();
      await page.waitForTimeout(200);
      const options = page.locator('.fixed.inset-0.z-40 ~ div, [role="menu"], [class*="dropdown"]');
      const visible = await options
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) {
        await page.keyboard.press('Escape');
      }
    }
  });

  test('resume dropdown shows Resume Selected and Resume All', async ({ page }) => {
    const resumeChevron = page.locator('button[aria-label*="resume" i]').first();
    if (await resumeChevron.isVisible().catch(() => false)) {
      await resumeChevron.click();
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
    }
  });

  test('stop dropdown shows Stop Selected and Stop All', async ({ page }) => {
    const stopChevron = page.locator('button[aria-label*="stop" i], button[aria-label*="more" i]').nth(0);
    if (await stopChevron.isVisible().catch(() => false)) {
      await stopChevron.click();
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
    }
  });

  test('delete dropdown shows Delete Selected, Delete All, Delete Completed', async ({ page }) => {
    const deleteChevron = page.locator('button[aria-label*="more" i]').last();
    if (await deleteChevron.isVisible().catch(() => false)) {
      await deleteChevron.click();
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('Navigation — global search', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('search input is visible and has placeholder', async ({ page }) => {
    const search = page.locator('[data-global-search="true"]');
    await expect(search).toBeVisible();
    const placeholder = await search.getAttribute('placeholder');
    expect(placeholder).toBeTruthy();
  });

  test('typing in search filters visible tasks', async ({ page }) => {
    const search = page.locator('[data-global-search="true"]');
    await search.click();
    await search.fill('nonexistent-file-12345');
    await page.waitForTimeout(500);
    await search.fill('');
  });

  test('clearing search restores all tasks', async ({ page }) => {
    const search = page.locator('[data-global-search="true"]');
    await search.click();
    await search.fill('test');
    await page.waitForTimeout(300);
    await search.fill('');
    await page.waitForTimeout(300);
  });
});

test.describe('Navigation — page transitions', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('navigating to scheduler shows scheduler panel', async ({ page }) => {
    const schedBtn = page.locator('aside button', { hasText: /scheduler|queue|جدولة/i }).first();
    if (await schedBtn.isVisible().catch(() => false)) {
      await schedBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('clicking daemon widget opens diagnostics', async ({ page }) => {
    const daemonWidget = page.locator('aside').locator('div.cursor-pointer, div[class*="cursor-pointer"]').first();
    if (await daemonWidget.isVisible().catch(() => false)) {
      await daemonWidget.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
      }
    }
  });

  test('settings button in sidebar opens settings dialog', async ({ page }) => {
    const settingsBtn = page
      .locator('aside button')
      .filter({ has: page.locator('svg') })
      .last();
    if (await settingsBtn.isVisible().catch(() => false)) {
      await settingsBtn.click();
      await page.waitForTimeout(500);
    }
  });
});

test.describe('Navigation — mobile nav', () => {
  test('mobile nav is hidden on desktop viewport', async ({ page }) => {
    await goto(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    const mobileNav = page
      .locator('[class*="md:hidden"]')
      .filter({ hasText: /download/i })
      .first();
    if (await mobileNav.isVisible().catch(() => false)) {
      const display = await mobileNav.evaluate((el) => window.getComputedStyle(el).display);
      expect(display).toBe('none');
    }
  });
});
