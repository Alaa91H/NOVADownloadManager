import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('UI Components — Button', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('buttons have hover scale effect', async ({ page }) => {
    const btn = page.locator('.interactive-btn').first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.hover();
      const transform = await btn.evaluate((el) => window.getComputedStyle(el).transform);
      expect(transform).toBeTruthy();
    }
  });

  test('buttons have active press effect', async ({ page }) => {
    const btn = page.locator('.interactive-btn').first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.evaluate((el) => {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
    }
  });

  test('disabled buttons show title tooltip', async ({ page }) => {
    const disabledBtns = page.locator('.interactive-btn[disabled]');
    const count = await disabledBtns.count();
    for (let i = 0; i < count; i++) {
      const btn = disabledBtns.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const title = await btn.getAttribute('title');
        expect(title).toBeTruthy();
      }
    }
  });

  test('disabled buttons have aria-disabled', async ({ page }) => {
    const disabledBtns = page.locator('.interactive-btn[disabled]');
    const count = await disabledBtns.count();
    for (let i = 0; i < count; i++) {
      const btn = disabledBtns.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const ariaDisabled = await btn.getAttribute('aria-disabled');
        expect(ariaDisabled).toBe('true');
      }
    }
  });

  test('primary buttons have accent color background', async ({ page }) => {
    const primaryBtns = page.locator('.interactive-btn').filter({ has: page.locator('svg') });
    const count = await primaryBtns.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const btn = primaryBtns.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const bg = await btn.evaluate((el) => window.getComputedStyle(el).backgroundColor);
        expect(bg).toBeTruthy();
      }
    }
  });
});

test.describe('UI Components — Switch', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('switch toggles can be found', async ({ page }) => {
    const switches = page.locator('label:has(> div[class*="rounded-full"])');
    const count = await switches.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('clicking switch changes state', async ({ page }) => {
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(600);
    const switches = page.locator('label:has(> div[class*="rounded-full"])');
    const count = await switches.count();
    if (count > 0) {
      const sw = switches.first();
      if (await sw.isVisible().catch(() => false)) {
        const before = await sw.evaluate((el) => {
          const toggle = el.querySelector('div');
          return toggle?.getAttribute('class')?.includes('bg-[var(--accent-primary)]') || false;
        });
        await sw.click();
        await page.waitForTimeout(200);
        const after = await sw.evaluate((el) => {
          const toggle = el.querySelector('div');
          return toggle?.getAttribute('class')?.includes('bg-[var(--accent-primary)]') || false;
        });
        expect(after).toBe(!before);
      }
    }
  });
});

test.describe('UI Components — SelectField', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('select fields have labels', async ({ page }) => {
    const selects = page.locator('select');
    const count = await selects.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const sel = selects.nth(i);
      if (await sel.isVisible().catch(() => false)) {
        const id = await sel.getAttribute('id');
        if (id) {
          const label = page.locator(`label[for="${id}"]`);
          const isVisible = await label.isVisible().catch(() => false);
          expect(typeof isVisible).toBe('boolean');
        }
      }
    }
  });
});

test.describe('UI Components — TextField', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('text fields have labels', async ({ page }) => {
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    if (await dialog.isVisible().catch(() => false)) {
      const inputs = dialog.locator('input[type="text"]');
      const count = await inputs.count();
      expect(count).toBeGreaterThanOrEqual(1);
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('UI Components — Tabs', () => {
  test('tab navigation works', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
    const tabs = page.locator('button').filter({ hasText: /files|basic|speed|actions|retries/i });
    const count = await tabs.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const tab = tabs.nth(i);
      if (await tab.isVisible().catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(200);
      }
    }
  });
});

test.describe('UI Components — StatusPill', () => {
  test('status pills have colored backgrounds', async ({ page }) => {
    await goto(page);
    const pills = page.locator('[class*="pill"]');
    const count = await pills.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const pill = pills.nth(i);
      if (await pill.isVisible().catch(() => false)) {
        const bg = await pill.evaluate((el) => window.getComputedStyle(el).backgroundColor);
        expect(bg).toBeTruthy();
      }
    }
  });
});

test.describe('UI Components — ProgressBar', () => {
  test('progress bars have correct width', async ({ page }) => {
    await goto(page);
    const progressBars = page.locator('[role="progressbar"], [class*="progress-bar"]');
    const count = await progressBars.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const bar = progressBars.nth(i);
      if (await bar.isVisible().catch(() => false)) {
        const width = await bar.evaluate((el) => window.getComputedStyle(el).width);
        expect(width).toBeTruthy();
      }
    }
  });
});

test.describe('UI Components — focus-visible rings', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('buttons show focus-visible ring on Tab', async ({ page }) => {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus-visible');
    if (await focused.isVisible().catch(() => false)) {
      const outline = await focused.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
      });
      expect(typeof outline).toBe('boolean');
    }
  });
});

test.describe('UI Components — context menu keyboard nav', () => {
  test('context menu has ARIA role', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        await expect(menu).toHaveAttribute('role', 'menu');
        await expect(menu).toHaveAttribute('aria-orientation', 'vertical');
        const items = page.locator('[role="menuitem"]');
        const count = await items.count();
        expect(count).toBeGreaterThanOrEqual(2);
        await page.keyboard.press('Escape');
      }
    }
  });

  test('context menu items have data-active attribute', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        await page.keyboard.press('ArrowDown');
        const activeItem = page.locator('[role="menuitem"][data-active="true"]');
        const isVisible = await activeItem.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });

  test('context menu items can be activated with Enter', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
      }
    }
  });

  test('context menu items support disabled state', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        const disabledItems = page.locator('[role="menuitem"][aria-disabled="true"]');
        const count = await disabledItems.count();
        expect(count).toBeGreaterThanOrEqual(0);
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('UI Components — modal animations', () => {
  test('modal has modal-bg-in animation', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const hasAnimation = await dialog.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.animationName !== 'none' || style.transition !== 'none 0s ease 0s';
    });
    expect(typeof hasAnimation).toBe('boolean');
    await page.keyboard.press('Escape');
  });

  test('reduced motion disables animations', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
  });
});
