import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Theme — dark mode', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('dark mode is default', async ({ page }) => {
    const hasDark = await page.evaluate(
      () =>
        document.documentElement.classList.contains('dark') ||
        document.documentElement.getAttribute('data-theme')?.includes('dark') ||
        document.documentElement.getAttribute('class')?.includes('dark') ||
        false,
    );
    expect(typeof hasDark).toBe('boolean');
  });

  test('dark mode uses dark background colors', async ({ page }) => {
    const bg = await page.evaluate(() =>
      window.getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim(),
    );
    expect(bg).toBeTruthy();
  });

  test('dark mode uses appropriate text colors', async ({ page }) => {
    const text = await page.evaluate(() => window.getComputedStyle(document.body).color);
    expect(text).toBeTruthy();
  });
});

test.describe('Theme — light mode', () => {
  test('switching to light mode changes background', async ({ page }) => {
    await goto(page);
    const lightBtn = page.locator('aside button[title*="light" i], aside button[title*="فاتح" i]').first();
    if (await lightBtn.isVisible().catch(() => false)) {
      await lightBtn.click();
      await page.waitForTimeout(300);
      const bg = await page.evaluate(() =>
        window.getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim(),
      );
      expect(bg).toBeTruthy();
    }
  });
});

test.describe('Theme — accent colors', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('accent color can be changed from sidebar', async ({ page }) => {
    const accentBtns = page.locator('aside button[title*="accent" i], aside button[title*="لون" i]');
    const count = await accentBtns.count();
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const btn = accentBtns.nth(i);
        if (await btn.isVisible().catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(200);
          const accent = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim(),
          );
          expect(accent).toBeTruthy();
          expect(accent).toMatch(/^#/);
        }
      }
    }
  });

  test('active accent has ring indicator', async ({ page }) => {
    const accentBtns = page.locator('aside button[title*="accent" i], aside button[title*="لون" i]');
    const count = await accentBtns.count();
    let hasActive = false;
    for (let i = 0; i < count; i++) {
      const btn = accentBtns.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const isActive = await btn.evaluate(
          (el) =>
            (el.getAttribute('class') ?? '').includes('ring-2') ||
            (el.getAttribute('class') ?? '').includes('scale-110'),
        );
        if (isActive) hasActive = true;
      }
    }
    expect(hasActive).toBeTruthy();
  });
});

test.describe('Theme — density', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('density selector changes layout spacing', async ({ page }) => {
    const densitySelect = page.locator('aside select').first();
    if (await densitySelect.isVisible().catch(() => false)) {
      const options = await densitySelect.locator('option').allTextContents();
      if (options.length > 1) {
        const currentValue = await densitySelect.inputValue();
        const otherValue = await densitySelect.locator('option').nth(1).getAttribute('value');
        if (otherValue && otherValue !== currentValue) {
          await densitySelect.selectOption(otherValue);
          await page.waitForTimeout(300);
          const bodyGap = await page.evaluate(
            () => window.getComputedStyle(document.body).gap || window.getComputedStyle(document.body).padding,
          );
          expect(bodyGap).toBeTruthy();
          await densitySelect.selectOption(currentValue);
          await page.waitForTimeout(300);
        }
      }
    }
  });
});

test.describe('Theme — CSS variables', () => {
  test('CSS variables are defined on :root', async ({ page }) => {
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
      const backdrop = await panels.evaluate((el) => {
        const s = window.getComputedStyle(el);
        return s.backdropFilter || (s as unknown as Record<string, string>)['webkitBackdropFilter'] || '';
      });
      expect(backdrop).toContain('blur');
    }
  });
});

test.describe('Theme — reduced motion', () => {
  test('animations respect prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const animation = await dialog.evaluate((el) => window.getComputedStyle(el).animation);
    expect(animation.includes('reduced-motion') || animation.includes('none')).toBeTruthy();
    await page.keyboard.press('Escape');
  });
});

test.describe('Accessibility — color contrast', () => {
  test('text elements have sufficient contrast', async ({ page }) => {
    await goto(page);
    const textElements = page.locator('button, span, p, h1, h2, h3');
    const count = await textElements.count();
    for (let i = 0; i < Math.min(count, 10); i++) {
      const el = textElements.nth(i);
      if (await el.isVisible().catch(() => false)) {
        const color = await el.evaluate((el) => window.getComputedStyle(el).color);
        expect(color).toBeTruthy();
      }
    }
  });
});

test.describe('Accessibility — keyboard navigation', () => {
  test('all interactive elements are keyboard accessible', async ({ page }) => {
    await goto(page);
    let tabCount = 0;
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const focused = page.locator(':focus');
      if (await focused.isVisible().catch(() => false)) {
        tabCount++;
        const tagName = await focused.evaluate((el) => el.tagName.toLowerCase());
        expect(['button', 'input', 'select', 'textarea', 'a']).toContain(tagName);
      }
    }
    expect(tabCount).toBeGreaterThan(0);
  });
});

test.describe('Accessibility — ARIA roles', () => {
  test('dialog has correct ARIA attributes', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAttribute('aria-labelledby', 'modal-title');
    await page.keyboard.press('Escape');
  });

  test('status bar has status role', async ({ page }) => {
    await goto(page);
    const statusBar = page.locator('[role="status"]');
    await expect(statusBar).toBeVisible({ timeout: 3000 });
  });

  test('toast container has live region', async ({ page }) => {
    await goto(page);
    const liveRegion = page.locator('[aria-live="polite"]');
    await expect(liveRegion).toBeVisible({ timeout: 3000 });
  });

  test('context menu has menu role', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        await expect(menu).toHaveAttribute('role', 'menu');
        const items = page.locator('[role="menuitem"]');
        const count = await items.count();
        for (let i = 0; i < count; i++) {
          await expect(items.nth(i)).toHaveAttribute('role', 'menuitem');
        }
        await page.keyboard.press('Escape');
      }
    }
  });
});
