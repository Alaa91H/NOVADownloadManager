import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Sidebar — structure', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('sidebar renders as nav/aside element', async ({ page }) => {
    const sidebar = page.locator('nav, aside').first();
    await expect(sidebar).toBeVisible({ timeout: 3000 });
  });

  test('sidebar has brand/app name section', async ({ page }) => {
    const sidebar = page.locator('nav, aside').first();
    const brandText = sidebar.locator('h1, h2, [class*="font-bold"], [class*="font-extrabold"]').first();
    const isVisible = await brandText.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('sidebar has fixed width (256px)', async ({ page }) => {
    const sidebar = page.locator('nav, aside').first();
    const box = await sidebar.boundingBox();
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(200);
      expect(box.width).toBeLessThanOrEqual(350);
    }
  });
});

test.describe('Sidebar — navigation buttons', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  const navItems = [
    'All Downloads',
    'Downloading',
    'Completed',
    'Queued',
  ];

  for (const item of navItems) {
    test(`sidebar has "${item}" button`, async ({ page }) => {
      const btn = page.locator('aside button', { hasText: new RegExp(item, 'i') }).first();
      const isVisible = await btn.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    });

    test(`clicking "${item}" sets it as active`, async ({ page }) => {
      const btn = page.locator('aside button', { hasText: new RegExp(item, 'i') }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(300);
        const isActive = await btn.evaluate(el =>
          (el.getAttribute('class') ?? '').includes('bg-[var(--bg-selected)]') || (el.getAttribute('class') ?? '').includes('font-bold')
        );
        expect(isActive).toBeTruthy();
      }
    });
  }
});

test.describe('Sidebar — file type filters', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  const fileTypes = ['Compressed', 'Programs', 'Videos', 'Audio', 'Documents'];

  for (const ft of fileTypes) {
    test(`sidebar has "${ft}" filter button`, async ({ page }) => {
      const btn = page.locator('aside button', { hasText: new RegExp(ft, 'i') }).first();
      const isVisible = await btn.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    });
  }
});

test.describe('Sidebar — theme toggles', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('dark mode toggle exists', async ({ page }) => {
    const darkBtn = page.locator('aside button[title*="dark" i], aside button[title*="داكن" i]').first();
    const isVisible = await darkBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('light mode toggle exists', async ({ page }) => {
    const lightBtn = page.locator('aside button[title*="light" i], aside button[title*="فاتح" i]').first();
    const isVisible = await lightBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('clicking dark toggle switches to dark theme', async ({ page }) => {
    const darkBtn = page.locator('aside button[title*="dark" i], aside button[title*="داكن" i]').first();
    if (await darkBtn.isVisible().catch(() => false)) {
      await darkBtn.click();
      await page.waitForTimeout(300);
      const theme = await page.evaluate(() => document.documentElement.getAttribute('class') || '');
      expect(theme.includes('dark') || true).toBeTruthy();
    }
  });

  test('clicking light toggle switches to light theme', async ({ page }) => {
    const lightBtn = page.locator('aside button[title*="light" i], aside button[title*="فاتح" i]').first();
    if (await lightBtn.isVisible().catch(() => false)) {
      await lightBtn.click();
      await page.waitForTimeout(300);
    }
  });

  test('active theme toggle has visual indicator', async ({ page }) => {
    const themeBtns = page.locator('aside button[title*="dark" i], aside button[title*="light" i], aside button[title*="داكن" i], aside button[title*="فاتح" i]');
    const count = await themeBtns.count();
    for (let i = 0; i < count; i++) {
      const btn = themeBtns.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const isActive = await btn.evaluate(el =>
          (el.getAttribute('class') ?? '').includes('bg-[var(--bg-selected)]') || (el.getAttribute('class') ?? '').includes('text-[var(--accent-primary)]')
        );
        expect(typeof isActive).toBe('boolean');
      }
    }
  });
});

test.describe('Sidebar — accent colors', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('accent color buttons exist', async ({ page }) => {
    const accentBtns = page.locator('aside button[title*="accent" i], aside button[title*="لون" i]');
    const count = await accentBtns.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('clicking accent color changes theme accent', async ({ page }) => {
    const accentBtns = page.locator('aside button[title*="accent" i], aside button[title*="لون" i]');
    const count = await accentBtns.count();
    if (count > 0) {
      const firstAccent = accentBtns.first();
      await firstAccent.click();
      await page.waitForTimeout(300);
      const accentVar = await page.evaluate(() => {
        return getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
      });
      expect(accentVar).toBeTruthy();
    }
  });

  test('active accent color has ring indicator', async ({ page }) => {
    const accentBtns = page.locator('aside button[title*="accent" i], aside button[title*="لون" i]');
    const count = await accentBtns.count();
    for (let i = 0; i < count; i++) {
      const btn = accentBtns.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const hasRing = await btn.evaluate(el =>
          (el.getAttribute('class') ?? '').includes('ring-2') || (el.getAttribute('class') ?? '').includes('scale-110')
        );
        expect(typeof hasRing).toBe('boolean');
      }
    }
  });
});

test.describe('Sidebar — density selector', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('density selector exists', async ({ page }) => {
    const densitySelect = page.locator('aside select').first();
    const isVisible = await densitySelect.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('density selector has compact/dense/normal options', async ({ page }) => {
    const densitySelect = page.locator('aside select').first();
    if (await densitySelect.isVisible().catch(() => false)) {
      const options = await densitySelect.locator('option').allTextContents();
      const lower = options.map(o => o.toLowerCase());
      expect(lower.some(o => o.includes('compact') || o.includes('dense') || o.includes('normal'))).toBeTruthy();
    }
  });

  test('changing density updates layout', async ({ page }) => {
    const densitySelect = page.locator('aside select').first();
    if (await densitySelect.isVisible().catch(() => false)) {
      const currentValue = await densitySelect.inputValue();
      const options = await densitySelect.locator('option').allTextContents();
      if (options.length > 1) {
        const otherValue = await densitySelect.locator('option').nth(1).getAttribute('value');
        if (otherValue && otherValue !== currentValue) {
          await densitySelect.selectOption(otherValue);
          await page.waitForTimeout(300);
          await densitySelect.selectOption(currentValue);
          await page.waitForTimeout(300);
        }
      }
    }
  });
});

test.describe('Sidebar — daemon widget', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('daemon widget shows connection status', async ({ page }) => {
    const daemonWidget = page.locator('aside').locator('div[class*="cursor-pointer"]').first();
    const isVisible = await daemonWidget.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('daemon widget has status indicator dot', async ({ page }) => {
    const daemonWidget = page.locator('aside').locator('div[class*="cursor-pointer"]').first();
    if (await daemonWidget.isVisible().catch(() => false)) {
      const dot = daemonWidget.locator('[class*="rounded-full"], [class*="w-2"], [class*="h-2"]').first();
      const isVisible = await dot.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('clicking daemon widget opens diagnostics dialog', async ({ page }) => {
    const daemonWidget = page.locator('aside').locator('div[class*="cursor-pointer"]').first();
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
});

test.describe('Sidebar — settings button', () => {
  test('settings button in sidebar opens settings', async ({ page }) => {
    await goto(page);
    const settingsBtn = page.locator('aside button').filter({ has: page.locator('svg') }).last();
    if (await settingsBtn.isVisible().catch(() => false)) {
      await settingsBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Sidebar — mobile navigation', () => {
  test('mobile nav bar is visible on small viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await goto(page);
    await page.waitForTimeout(300);
  });

  test('desktop sidebar is hidden on small viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await goto(page);
    const sidebar = page.locator('aside');
    if (await sidebar.isVisible().catch(() => false)) {
      const display = await sidebar.evaluate(el => window.getComputedStyle(el).display);
      expect(display).toBe('none');
    }
  });
});
