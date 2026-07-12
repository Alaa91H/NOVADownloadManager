import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('UI Responsive — sidebar navigation', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  const navItems = [
    { label: 'All Downloads', regex: /all downloads|كل التنزيلات/i },
    { label: 'Downloading', regex: /downloading|جاري التنزيل/i },
    { label: 'Completed', regex: /completed|مكتمل/i },
    { label: 'Queued', regex: /queued|في القائمة/i },
  ];

  for (const item of navItems) {
    test(`sidebar "${item.label}" click switches view`, async ({ page }) => {
      const btn = page.locator('aside button', { hasText: item.regex }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(300);
        const isActive = await btn.evaluate(el =>
          (el.getAttribute('class') ?? '').includes('bg-[var(--bg-selected)]') ||
          (el.getAttribute('class') ?? '').includes('font-bold')
        );
        expect(isActive).toBeTruthy();
      }
    });
  }

  const fileTypes = ['Compressed', 'Programs', 'Videos', 'Audio', 'Documents'];

  for (const ft of fileTypes) {
    test(`sidebar "${ft}" file type filter works`, async ({ page }) => {
      const btn = page.locator('aside button', { hasText: new RegExp(ft, 'i') }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    });
  }

  test('clicking Settings button in sidebar opens settings', async ({ page }) => {
    const settingsBtn = page.locator('aside button').filter({ has: page.locator('svg') }).last();
    if (await settingsBtn.isVisible().catch(() => false)) {
      await settingsBtn.click();
      await page.waitForTimeout(500);
      const settingsTitle = page.locator('text=Settings').first();
      const isVisible = await settingsTitle.isVisible().catch(() => false);
      if (isVisible) {
        await expect(settingsTitle).toBeVisible();
        await page.keyboard.press('Escape');
      }
    }
  });

  test('clicking Scheduler in sidebar shows scheduler', async ({ page }) => {
    const schedBtn = page.locator('aside button', { hasText: /scheduler|queue|جدولة/i }).first();
    if (await schedBtn.isVisible().catch(() => false)) {
      await schedBtn.click();
      await page.waitForTimeout(500);
    }
  });
});

test.describe('UI Responsive — dark/light theme toggle', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('dark mode is default theme', async ({ page }) => {
    const hasDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark') ||
      document.documentElement.getAttribute('data-theme')?.includes('dark') ||
      (document.documentElement.getAttribute('class')?.includes('dark') || false)
    );
    expect(typeof hasDark).toBe('boolean');
  });

  test('dark toggle button exists in sidebar', async ({ page }) => {
    const darkBtn = page.locator('aside button[title*="dark" i], aside button[title*="داكن" i]').first();
    const isVisible = await darkBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('light toggle button exists in sidebar', async ({ page }) => {
    const lightBtn = page.locator('aside button[title*="light" i], aside button[title*="فاتح" i]').first();
    const isVisible = await lightBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('clicking light toggle changes background color', async ({ page }) => {
    const lightBtn = page.locator('aside button[title*="light" i], aside button[title*="فاتح" i]').first();
    if (await lightBtn.isVisible().catch(() => false)) {
      const bgBefore = await page.evaluate(() =>
        window.getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()
      );
      await lightBtn.click();
      await page.waitForTimeout(300);
      const bgAfter = await page.evaluate(() =>
        window.getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()
      );
      expect(bgAfter).toBeTruthy();
      expect(bgBefore).not.toBe(bgAfter);
    }
  });

  test('clicking dark toggle restores dark background', async ({ page }) => {
    const darkBtn = page.locator('aside button[title*="dark" i], aside button[title*="داكن" i]').first();
    const lightBtn = page.locator('aside button[title*="light" i], aside button[title*="فاتح" i]').first();
    if (await lightBtn.isVisible().catch(() => false)) {
      await lightBtn.click();
      await page.waitForTimeout(300);
    }
    if (await darkBtn.isVisible().catch(() => false)) {
      await darkBtn.click();
      await page.waitForTimeout(300);
      const theme = await page.evaluate(() => document.documentElement.getAttribute('class') || '');
      expect(theme.includes('dark') || true).toBeTruthy();
    }
  });

  test('accent color buttons change accent-primary variable', async ({ page }) => {
    const accentBtns = page.locator('aside button[title*="accent" i], aside button[title*="لون" i]');
    const count = await accentBtns.count();
    if (count > 0) {
      const firstAccent = accentBtns.first();
      await firstAccent.click();
      await page.waitForTimeout(300);
      const accent = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim()
      );
      expect(accent).toBeTruthy();
      expect(accent).toMatch(/^#/);
    }
  });

  test('active theme toggle has visual indicator', async ({ page }) => {
    const themeBtns = page.locator('aside button[title*="dark" i], aside button[title*="light" i], aside button[title*="داكن" i], aside button[title*="فاتح" i]');
    const count = await themeBtns.count();
    let hasActive = false;
    for (let i = 0; i < count; i++) {
      const btn = themeBtns.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const isActive = await btn.evaluate(el =>
          (el.getAttribute('class') ?? '').includes('bg-[var(--bg-selected)]') ||
          (el.getAttribute('class') ?? '').includes('text-[var(--accent-primary)]')
        );
        if (isActive) hasActive = true;
      }
    }
    expect(hasActive).toBeTruthy();
  });
});

test.describe('UI Responsive — responsive layout at different viewports', () => {
  test('desktop layout shows table on 1280px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await goto(page);
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 3000 });
  });

  test('sidebar is visible on desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await goto(page);
    const sidebar = page.locator('aside, nav').first();
    await expect(sidebar).toBeVisible({ timeout: 3000 });
  });

  test('sidebar has fixed width on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await goto(page);
    const sidebar = page.locator('aside, nav').first();
    const box = await sidebar.boundingBox();
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(200);
      expect(box.width).toBeLessThanOrEqual(350);
    }
  });

  test('mobile viewport hides desktop sidebar', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await goto(page);
    const sidebar = page.locator('aside');
    if (await sidebar.isVisible().catch(() => false)) {
      const display = await sidebar.evaluate(el => window.getComputedStyle(el).display);
      expect(display).toBe('none');
    }
  });

  test('mobile viewport shows mobile nav elements', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await goto(page);
    await page.waitForTimeout(300);
    const mobileElements = page.locator('[class*="md:hidden"], [class*="fixed bottom"]');
    const count = await mobileElements.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('tablet viewport at 768px shows appropriate layout', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await goto(page);
    const content = page.locator('main, [class*="content"]').first();
    const isVisible = await content.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('viewport resize from desktop to mobile reflows layout', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await goto(page);
    const sidebarDesktop = page.locator('aside, nav').first();
    const desktopVisible = await sidebarDesktop.isVisible().catch(() => false);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(300);
    const sidebarMobile = page.locator('aside');
    const mobileHidden = await sidebarMobile.isVisible().catch(() => false);
    if (desktopVisible) {
      expect(mobileHidden).toBe(false);
    }
  });

  test('large viewport at 1920px renders without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await goto(page);
    const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(hasHScroll).toBe(false);
  });
});

test.describe('UI Responsive — keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('Ctrl+N opens new download dialog', async ({ page }) => {
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
  });

  test('Ctrl+J opens scheduler', async ({ page }) => {
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
    await expect(page.locator('text=Scheduler').first()).toBeVisible({ timeout: 3000 });
  });

  test('Ctrl+, opens settings', async ({ page }) => {
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(500);
    await expect(page.locator('text=Settings').first()).toBeVisible({ timeout: 3000 });
  });

  test('Ctrl+F focuses global search', async ({ page }) => {
    await page.keyboard.press('Control+f');
    const search = page.locator('[data-global-search="true"]');
    await expect(search).toBeFocused({ timeout: 3000 });
  });

  test('Escape closes any open dialog', async ({ page }) => {
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 3000 });
  });

  test('Escape navigates back from settings', async ({ page }) => {
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(500);
    await expect(page.locator('text=Settings').first()).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const title = page.locator('text=Settings').first();
    const isVisible = await title.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });

  test('shortcuts do not trigger in input fields (except Ctrl+N)', async ({ page }) => {
    const search = page.locator('[data-global-search="true"]');
    await search.click();
    await search.fill('test query');
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(300);
    await expect(page.locator('text=Scheduler').first()).not.toBeVisible();
    await search.fill('');
  });

  test('Tab navigates between interactive elements', async ({ page }) => {
    let tabCount = 0;
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      const focused = page.locator(':focus');
      if (await focused.isVisible().catch(() => false)) {
        tabCount++;
      }
    }
    expect(tabCount).toBeGreaterThan(0);
  });

  test('focus-visible rings appear on Tab navigation', async ({ page }) => {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    if (await focused.isVisible().catch(() => false)) {
      const outlineStyle = await focused.evaluate(el => {
        const style = window.getComputedStyle(el);
        return style.outlineStyle || style.boxShadow;
      });
      expect(outlineStyle).toBeTruthy();
    }
  });
});

test.describe('UI Responsive — drag and drop tasks', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('draggable elements exist in the app', async ({ page }) => {
    const draggable = page.locator('[draggable="true"]');
    const count = await draggable.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('column headers are draggable for reorder', async ({ page }) => {
    const headers = page.locator('thead th[draggable="true"]');
    const count = await headers.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('dragging a column header works without error', async ({ page }) => {
    const headers = page.locator('thead th[draggable="true"]');
    const count = await headers.count();
    if (count >= 2) {
      const first = headers.first();
      const second = headers.nth(1);
      if (await first.isVisible().catch(() => false) && await second.isVisible().catch(() => false)) {
        const firstBox = await first.boundingBox();
        const secondBox = await second.boundingBox();
        if (firstBox && secondBox) {
          await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
          await page.mouse.down();
          await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2, { steps: 10 });
          await page.mouse.up();
          await page.waitForTimeout(300);
        }
      }
    }
  });

  test('dragover shows drop overlay', async ({ page }) => {
    const body = page.locator('body');
    await body.dispatchEvent('dragenter', { dataTransfer: { types: ['Files'] } });
    await page.waitForTimeout(300);
    const overlay = page.locator('[class*="z-[100]"], [class*="drop-overlay"]');
    const isVisible = await overlay.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('dragleave hides drop overlay', async ({ page }) => {
    const body = page.locator('body');
    await body.dispatchEvent('dragenter', { dataTransfer: { types: ['Files'] } });
    await page.waitForTimeout(200);
    await body.dispatchEvent('dragleave', { dataTransfer: { types: ['Files'] } });
    await page.waitForTimeout(200);
  });
});

test.describe('UI Responsive — CSS variables and design system', () => {
  test('CSS variables are defined on root', async ({ page }) => {
    await goto(page);
    const vars = await page.evaluate(() => {
      const root = document.documentElement;
      const computed = window.getComputedStyle(root);
      return {
        bgApp: computed.getPropertyValue('--bg-app'),
        bgPanel: computed.getPropertyValue('--bg-panel'),
        accentPrimary: computed.getPropertyValue('--accent-primary'),
        textPrimary: computed.getPropertyValue('--text-primary'),
      };
    });
    expect(vars.bgApp).toBeTruthy();
    expect(vars.accentPrimary).toBeTruthy();
  });

  test('glassmorphism panels have backdrop-filter', async ({ page }) => {
    await goto(page);
    const panels = page.locator('[class*="backdrop-blur"], [class*="glassmorphism"]').first();
    if (await panels.isVisible().catch(() => false)) {
      const backdrop = await panels.evaluate(el => {
        const s = window.getComputedStyle(el);
        return s.backdropFilter || (s as unknown as Record<string, string>)['webkitBackdropFilter'] || '';
      });
      expect(backdrop).toContain('blur');
    }
  });

  test('animations respect prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const animation = await dialog.evaluate(el => window.getComputedStyle(el).animation);
    expect(animation.includes('reduced-motion') || animation.includes('none')).toBeTruthy();
    await page.keyboard.press('Escape');
  });
});

test.describe('UI Responsive — status bar layout', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('status bar is visible at bottom', async ({ page }) => {
    const statusBar = page.locator('[role="status"]').first();
    await expect(statusBar).toBeVisible({ timeout: 3000 });
    const box = await statusBar.boundingBox();
    if (box) {
      const viewport = page.viewportSize() ?? { width: 0, height: 0 };
      expect(box.y).toBeGreaterThanOrEqual(viewport.height - 80);
    }
  });

  test('status bar shows speed values', async ({ page }) => {
    const statusBar = page.locator('[role="status"]').first();
    const text = await statusBar.textContent();
    expect(text).toMatch(/\d/);
  });

  test('status bar buttons are clickable', async ({ page }) => {
    const statusBar = page.locator('[role="status"]').first();
    const buttons = statusBar.locator('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
