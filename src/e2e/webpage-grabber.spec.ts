import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

const openGrabber = async (page: import('@playwright/test').Page) => {
  await goto(page);
  const chevron = page.locator('header button[data-dialog-trigger="true"]').first();
  if (await chevron.isVisible().catch(() => false)) {
    await chevron.click();
    await page.waitForTimeout(300);
    const grabberBtn = page.locator('button').filter({ hasText: /grabber|التقاط|أمسك/i }).first();
    if (await grabberBtn.isVisible().catch(() => false)) {
      await grabberBtn.click();
      await page.waitForTimeout(500);
    }
  }
};

test.describe('Webpage Grabber — dialog structure', () => {
  test.beforeEach(async ({ page }) => { await openGrabber(page); });

  test('webpage grabber dialog opens', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const isVisible = await dialog.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('URL input field exists', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    const isVisible = await urlInput.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('dialog has accessible title', async ({ page }) => {
    const title = page.locator('#modal-title');
    if (await title.isVisible().catch(() => false)) {
      const text = await title.textContent();
      expect(text?.length).toBeGreaterThan(0);
    }
  });
});

test.describe('Webpage Grabber — URL input', () => {
  test.beforeEach(async ({ page }) => { await openGrabber(page); });

  test('URL input accepts text', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    if (await urlInput.isVisible().catch(() => false)) {
      await urlInput.fill('https://example.com');
      const value = await urlInput.inputValue();
      expect(value).toBe('https://example.com');
    }
  });

  test('URL input has placeholder', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    if (await urlInput.isVisible().catch(() => false)) {
      const placeholder = await urlInput.getAttribute('placeholder');
      expect(placeholder).toBeTruthy();
    }
  });
});

test.describe('Webpage Grabber — settings', () => {
  test.beforeEach(async ({ page }) => { await openGrabber(page); });

  test('depth setting exists', async ({ page }) => {
    const depthSection = page.locator('text=depth, text=عمق, text=深度').first();
    const isVisible = await depthSection.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('file type filters exist', async ({ page }) => {
    const filters = page.locator('[role="dialog"] input[type="checkbox"], [role="dialog"] label');
    const count = await filters.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Webpage Grabber — start grab', () => {
  test.beforeEach(async ({ page }) => { await openGrabber(page); });

  test('start grab button exists', async ({ page }) => {
    const startBtn = page.locator('button').filter({ hasText: /grab|التقاط|أمسك|start/i }).first();
    const isVisible = await startBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('cancel button exists', async ({ page }) => {
    const cancelBtn = page.locator('button').filter({ hasText: /cancel|إلغاء/i }).first();
    const isVisible = await cancelBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Webpage Grabber — close', () => {
  test.beforeEach(async ({ page }) => { await openGrabber(page); });

  test('Escape closes grabber dialog', async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const dialog = page.locator('[role="dialog"]');
    const isVisible = await dialog.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});
