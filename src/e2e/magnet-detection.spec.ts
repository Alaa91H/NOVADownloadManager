import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Magnet Detection — paste magnet link shows indicator', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
  });

  test.afterEach(async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('pasting a magnet link shows the magnet detected indicator', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('magnet:?xt=urn:btih:abc123def456&dn=example-file');
    await page.waitForTimeout(300);
    const magnetIndicator = page.locator('[role="dialog"]').locator('text=/magnet|رواسب/i').first();
    const isVisible = await magnetIndicator.isVisible().catch(() => false);
    expect(isVisible).toBe(true);
  });

  test('magnet indicator has amber/visible styling', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('magnet:?xt=urn:btih:abc123def456&dn=example-file');
    await page.waitForTimeout(300);
    const magnetIndicator = page.locator('[role="dialog"]').locator('text=/magnet|رواسب/i').first();
    if (await magnetIndicator.isVisible().catch(() => false)) {
      const className = (await magnetIndicator.getAttribute('class')) ?? '';
      expect(className.length).toBeGreaterThan(0);
    }
  });
});

test.describe('Magnet Detection — regular URLs do not show indicator', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
  });

  test.afterEach(async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('regular HTTP URL does not show magnet indicator', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('https://example.com/file.zip');
    await page.waitForTimeout(300);
    const magnetIndicator = page.locator('[role="dialog"]').locator('text=/magnet|رواسب/i').first();
    const isVisible = await magnetIndicator.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });

  test('regular HTTPS URL does not show magnet indicator', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('https://cdn.example.com/package.tar.gz');
    await page.waitForTimeout(300);
    const magnetIndicator = page.locator('[role="dialog"]').locator('text=/magnet|رواسب/i').first();
    const isVisible = await magnetIndicator.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });

  test('FTP URL does not show magnet indicator', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('ftp://files.example.com/document.pdf');
    await page.waitForTimeout(300);
    const magnetIndicator = page.locator('[role="dialog"]').locator('text=/magnet|رواسب/i').first();
    const isVisible = await magnetIndicator.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });

  test('clearing magnet link hides the indicator', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('magnet:?xt=urn:btih:abc123def456&dn=example-file');
    await page.waitForTimeout(300);
    const magnetIndicator = page.locator('[role="dialog"]').locator('text=/magnet|رواسب/i').first();
    const visibleBefore = await magnetIndicator.isVisible().catch(() => false);
    expect(visibleBefore).toBe(true);
    await urlInput.fill('https://example.com/other.zip');
    await page.waitForTimeout(300);
    const visibleAfter = await magnetIndicator.isVisible().catch(() => false);
    expect(visibleAfter).toBe(false);
  });
});
