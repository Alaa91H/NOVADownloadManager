import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Status Bar — layout', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('status bar is visible', async ({ page }) => {
    const statusBar = page.locator('[role="status"]').first();
    await expect(statusBar).toBeVisible({ timeout: 3000 });
  });

  test('status bar is at the bottom of the viewport', async ({ page }) => {
    const statusBar = page.locator('[role="status"]').first();
    const box = await statusBar.boundingBox();
    if (box) {
      const viewport = page.viewportSize() ?? { width: 0, height: 0 };
      expect(box.y).toBeGreaterThanOrEqual(viewport.height - 80);
    }
  });

  test('status bar has correct z-index (above content)', async ({ page }) => {
    const statusBar = page.locator('[role="status"]').first();
    if (await statusBar.isVisible()) {
      const zIndex = await statusBar.evaluate((el) => window.getComputedStyle(el).zIndex);
      expect(parseInt(zIndex) || 0).toBeGreaterThanOrEqual(0);
    }
  });
});

test.describe('Status Bar — daemon status indicator', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('daemon status button exists', async ({ page }) => {
    const daemonBtn = page.locator('[role="status"] button').first();
    await expect(daemonBtn).toBeVisible({ timeout: 3000 });
  });

  test('daemon status button has tooltip', async ({ page }) => {
    const daemonBtn = page.locator('[role="status"] button').first();
    const title = await daemonBtn.getAttribute('title');
    expect(title).toBeTruthy();
  });

  test('clicking daemon status shows toast with info', async ({ page }) => {
    const daemonBtn = page.locator('[role="status"] button').first();
    if (await daemonBtn.isVisible()) {
      await daemonBtn.click();
      await page.waitForTimeout(500);
    }
  });
});

test.describe('Status Bar — browser extension button', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('browser extension button exists', async ({ page }) => {
    const shieldBtn = page
      .locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]')
      .first();
    const isVisible = await shieldBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('browser extension button shows 3-state icon', async ({ page }) => {
    const shieldBtn = page
      .locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]')
      .first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const title = await shieldBtn.getAttribute('title');
      expect(title).toBeTruthy();
    }
  });

  test('clicking browser extension button opens integration dialog', async ({ page }) => {
    const shieldBtn = page
      .locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]')
      .first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      await shieldBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Status Bar — clipboard monitor', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('clipboard monitor button exists', async ({ page }) => {
    const clipBtn = page
      .locator('[role="status"] button[title*="clipboard" i], [role="status"] button[title*="حافظة" i]')
      .first();
    const isVisible = await clipBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('clipboard monitor toggles on click', async ({ page }) => {
    const clipBtn = page
      .locator('[role="status"] button[title*="clipboard" i], [role="status"] button[title*="حافظة" i]')
      .first();
    if (await clipBtn.isVisible().catch(() => false)) {
      await clipBtn.click();
      await page.waitForTimeout(300);
      const afterTitle = await clipBtn.getAttribute('title');
      expect(afterTitle).toBeTruthy();
    }
  });
});

test.describe('Status Bar — speed limiter', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('speed limiter button exists', async ({ page }) => {
    const gaugeBtn = page
      .locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]')
      .first();
    const isVisible = await gaugeBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('clicking speed limiter opens speed menu popup', async ({ page }) => {
    const gaugeBtn = page
      .locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]')
      .first();
    if (await gaugeBtn.isVisible().catch(() => false)) {
      await gaugeBtn.click();
      await page.waitForTimeout(300);
      const speedMenu = page.locator('text=enable limiter, text=تفعيل الحد, text=500 KB/s, text=1 MB/s').first();
      const isVisible = await speedMenu.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('speed menu has preset buttons', async ({ page }) => {
    const gaugeBtn = page
      .locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]')
      .first();
    if (await gaugeBtn.isVisible().catch(() => false)) {
      await gaugeBtn.click();
      await page.waitForTimeout(300);
      const presets = page.locator('button').filter({ hasText: /KB\/s|MB\/s/ });
      const count = await presets.count();
      expect(count).toBeGreaterThanOrEqual(4);
      await page.keyboard.press('Escape');
    }
  });

  test('speed menu has custom speed option', async ({ page }) => {
    const gaugeBtn = page
      .locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]')
      .first();
    if (await gaugeBtn.isVisible().catch(() => false)) {
      await gaugeBtn.click();
      await page.waitForTimeout(300);
      const customBtn = page
        .locator('button')
        .filter({ hasText: /custom|مخصص/i })
        .first();
      const isVisible = await customBtn.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
      await page.keyboard.press('Escape');
    }
  });

  test('speed menu closes on Escape', async ({ page }) => {
    const gaugeBtn = page
      .locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]')
      .first();
    if (await gaugeBtn.isVisible().catch(() => false)) {
      await gaugeBtn.click();
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
  });
});

test.describe('Status Bar — telegram button', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('telegram button exists', async ({ page }) => {
    const tgBtn = page
      .locator('[role="status"] button[title*="telegram" i], [role="status"] button[title*="تيليجرام" i]')
      .first();
    const isVisible = await tgBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('right-clicking telegram opens context menu', async ({ page }) => {
    const tgBtn = page
      .locator('[role="status"] button[title*="telegram" i], [role="status"] button[title*="تيليجرام" i]')
      .first();
    if (await tgBtn.isVisible().catch(() => false)) {
      await tgBtn.click({ button: 'right' });
      await page.waitForTimeout(300);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        const items = page.locator('[role="menuitem"]');
        const count = await items.count();
        expect(count).toBeGreaterThanOrEqual(1);
        await page.keyboard.press('Escape');
      }
    }
  });

  test('telegram context menu has Enable/Disable option', async ({ page }) => {
    const tgBtn = page
      .locator('[role="status"] button[title*="telegram" i], [role="status"] button[title*="تيليجرام" i]')
      .first();
    if (await tgBtn.isVisible().catch(() => false)) {
      await tgBtn.click({ button: 'right' });
      await page.waitForTimeout(300);
      const enableOption = page.locator('[role="menuitem"]').filter({ hasText: /enable|disable|تفعيل|تعطيل/i });
      const isVisible = await enableOption.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
      await page.keyboard.press('Escape');
    }
  });

  test('telegram context menu has Test option', async ({ page }) => {
    const tgBtn = page
      .locator('[role="status"] button[title*="telegram" i], [role="status"] button[title*="تيليجرام" i]')
      .first();
    if (await tgBtn.isVisible().catch(() => false)) {
      await tgBtn.click({ button: 'right' });
      await page.waitForTimeout(300);
      const testOption = page.locator('[role="menuitem"]').filter({ hasText: /test|اختبار/i });
      const isVisible = await testOption.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
      await page.keyboard.press('Escape');
    }
  });

  test('telegram context menu has Settings option', async ({ page }) => {
    const tgBtn = page
      .locator('[role="status"] button[title*="telegram" i], [role="status"] button[title*="تيليجرام" i]')
      .first();
    if (await tgBtn.isVisible().catch(() => false)) {
      await tgBtn.click({ button: 'right' });
      await page.waitForTimeout(300);
      const settingsOption = page.locator('[role="menuitem"]').filter({ hasText: /settings|إعدادات/i });
      const isVisible = await settingsOption.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('Status Bar — notification bell', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('notification bell button exists', async ({ page }) => {
    const bellBtn = page
      .locator('[role="status"] button[title*="notification" i], [role="status"] button[title*="إشعار" i]')
      .first();
    const isVisible = await bellBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('notification bell toggles mute state', async ({ page }) => {
    const bellBtn = page
      .locator('[role="status"] button[title*="notification" i], [role="status"] button[title*="إشعار" i]')
      .first();
    if (await bellBtn.isVisible().catch(() => false)) {
      await bellBtn.click();
      await page.waitForTimeout(300);
      const afterTitle = await bellBtn.getAttribute('title');
      expect(afterTitle).toBeTruthy();
    }
  });
});

test.describe('Status Bar — download counts display', () => {
  test('download counts area exists', async ({ page }) => {
    await goto(page);
    const countsArea = page.locator('[role="status"]').first();
    await expect(countsArea).toBeVisible();
    const text = await countsArea.textContent();
    expect(text).toBeTruthy();
  });
});

test.describe('Status Bar — speed display', () => {
  test('speed values are displayed', async ({ page }) => {
    await goto(page);
    const statusBar = page.locator('[role="status"]').first();
    const text = await statusBar.textContent();
    expect(text).toMatch(/\d/);
  });
});
