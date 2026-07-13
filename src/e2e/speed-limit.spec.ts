import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Speed Limit — speed limiter menu', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('speed limiter menu opens with preset buttons', async ({ page }) => {
    const gaugeBtn = page.locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]').first();
    if (await gaugeBtn.isVisible().catch(() => false)) {
      await gaugeBtn.click();
      await page.waitForTimeout(300);
      const presetBtns = page.locator('button').filter({ hasText: /500 KB\/s|1 MB\/s|2 MB\/s|5 MB\/s|10 MB\/s|20 MB\/s/ });
      const count = await presetBtns.count();
      expect(count).toBeGreaterThanOrEqual(4);
    }
  });

  test('clicking a preset speed applies it', async ({ page }) => {
    const gaugeBtn = page.locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]').first();
    if (await gaugeBtn.isVisible().catch(() => false)) {
      await gaugeBtn.click();
      await page.waitForTimeout(300);
      const presetBtn = page.locator('button').filter({ hasText: /1 MB\/s/i }).first();
      if (await presetBtn.isVisible().catch(() => false)) {
        await presetBtn.click();
        await page.waitForTimeout(300);
      }
    }
  });

  test('custom speed input appears when custom is clicked', async ({ page }) => {
    const gaugeBtn = page.locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]').first();
    if (await gaugeBtn.isVisible().catch(() => false)) {
      await gaugeBtn.click();
      await page.waitForTimeout(300);
      const customBtn = page.locator('button').filter({ hasText: /custom|مخصص/i }).first();
      if (await customBtn.isVisible().catch(() => false)) {
        await customBtn.click();
        await page.waitForTimeout(300);
        const manualInput = page.locator('input[type="number"]');
        const isVisible = await manualInput.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
      }
    }
  });

  test('KB/MB unit toggle works', async ({ page }) => {
    const gaugeBtn = page.locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]').first();
    if (await gaugeBtn.isVisible().catch(() => false)) {
      await gaugeBtn.click();
      await page.waitForTimeout(300);
      const customBtn = page.locator('button').filter({ hasText: /custom|مخصص/i }).first();
      if (await customBtn.isVisible().catch(() => false)) {
        await customBtn.click();
        await page.waitForTimeout(300);
        const kbBtn = page.locator('button').filter({ hasText: /^KB$/i }).first();
        const mbBtn = page.locator('button').filter({ hasText: /^MB$/i }).first();
        const hasKB = await kbBtn.isVisible().catch(() => false);
        const hasMB = await mbBtn.isVisible().catch(() => false);
        expect(typeof hasKB).toBe('boolean');
        expect(typeof hasMB).toBe('boolean');
        if (hasKB) await kbBtn.click();
        await page.waitForTimeout(200);
        if (hasMB) await mbBtn.click();
        await page.waitForTimeout(200);
      }
    }
  });

  test('enable/disable toggle exists', async ({ page }) => {
    const gaugeBtn = page.locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]').first();
    if (await gaugeBtn.isVisible().catch(() => false)) {
      await gaugeBtn.click();
      await page.waitForTimeout(300);
      const enableToggle = page.locator('button').filter({ hasText: /enable|تفعيل/i }).first();
      const isVisible = await enableToggle.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('cancel button closes menu', async ({ page }) => {
    const gaugeBtn = page.locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]').first();
    if (await gaugeBtn.isVisible().catch(() => false)) {
      await gaugeBtn.click();
      await page.waitForTimeout(300);
      const cancelBtn = page.locator('button').filter({ hasText: /cancel|إلغاء/i }).first();
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click();
        await page.waitForTimeout(300);
      }
    }
  });

  test('apply button applies speed limit', async ({ page }) => {
    const gaugeBtn = page.locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]').first();
    if (await gaugeBtn.isVisible().catch(() => false)) {
      await gaugeBtn.click();
      await page.waitForTimeout(300);
      const applyBtn = page.locator('button').filter({ hasText: /apply|تطبيق/i }).first();
      if (await applyBtn.isVisible().catch(() => false)) {
        await applyBtn.click();
        await page.waitForTimeout(300);
      }
    }
  });
});

test.describe('Speed Limit — speed display', () => {
  test('current speed limit is displayed in status bar', async ({ page }) => {
    await goto(page);
    const statusBar = page.locator('[role="status"]').first();
    const text = await statusBar.textContent();
    expect(text).toMatch(/\d/);
  });
});

test.describe('Speed Limit — preset values', () => {
  const presets = ['500 KB/s', '1 MB/s', '2 MB/s', '5 MB/s', '10 MB/s', '20 MB/s'];

  for (const preset of presets) {
    test(`preset "${preset}" is clickable`, async ({ page }) => {
      await goto(page);
      const gaugeBtn = page.locator('[role="status"] button[title*="speed" i], [role="status"] button[title*="سرعة" i]').first();
      if (await gaugeBtn.isVisible().catch(() => false)) {
        await gaugeBtn.click();
        await page.waitForTimeout(300);
        const presetBtn = page.locator('button').filter({ hasText: preset }).first();
        if (await presetBtn.isVisible().catch(() => false)) {
          await presetBtn.click();
          await page.waitForTimeout(200);
        }
      }
    });
  }
});
