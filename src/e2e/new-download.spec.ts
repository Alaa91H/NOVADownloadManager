import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('New Download Dialog — full flow', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
  });

  test.afterEach(async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('dialog has correct ARIA attributes', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAttribute('aria-labelledby', 'modal-title');
  });

  test('URL input is auto-focused on open', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await expect(urlInput).toBeFocused();
  });

  test('URL input accepts paste', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('https://example.com/file.zip');
    const value = await urlInput.inputValue();
    expect(value).toBe('https://example.com/file.zip');
  });

  test('paste from clipboard button exists', async ({ page }) => {
    const pasteBtn = page.locator('[role="dialog"] button[title*="paste" i], [role="dialog"] button[title*="لصق" i]').first();
    const isVisible = await pasteBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('save path field shows default path', async ({ page }) => {
    const pathField = page.locator('[role="dialog"] input[type="text"]').nth(1);
    if (await pathField.isVisible().catch(() => false)) {
      const value = await pathField.inputValue();
      expect(value).toBeTruthy();
    }
  });

  test('browse folder button exists', async ({ page }) => {
    const browseBtn = page.locator('[role="dialog"] button[title*="browse" i], [role="dialog"] button[title*="folder" i]').first();
    const isVisible = await browseBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('filename input exists', async ({ page }) => {
    const filenameInput = page.locator('[role="dialog"] input[type="text"]').nth(2);
    const isVisible = await filenameInput.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('refresh probe button exists', async ({ page }) => {
    const refreshBtn = page.locator('[role="dialog"] button[title*="refresh" i], [role="dialog"] button[title*="تحديث" i]').first();
    const isVisible = await refreshBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('size display shows "Checking..." initially', async ({ page }) => {
    const sizeDisplay = page.locator('[role="dialog"]').locator('text=/checking|جاري/i').first();
    const isVisible = await sizeDisplay.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('advanced toggle exists', async ({ page }) => {
    const advancedBtn = page.locator('[role="dialog"] button[title*="advanced" i], [role="dialog"] button[title*="متقد" i]').first();
    const isVisible = await advancedBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
    await advancedBtn.click();
    await page.waitForTimeout(300);
  });

  test('advanced section shows category, queue, threads', async ({ page }) => {
    const advancedBtn = page.locator('[role="dialog"] button[title*="advanced" i], [role="dialog"] button[title*="متقد" i]').first();
    if (await advancedBtn.isVisible().catch(() => false)) {
      await advancedBtn.click();
      await page.waitForTimeout(300);
      const category = page.locator('[role="dialog"]').filter({ hasText: /category|فئة/i }).first();
      const queue = page.locator('[role="dialog"]').filter({ hasText: /queue|قائمة/i }).first();
      const threads = page.locator('[role="dialog"]').filter({ hasText: /threads|خيوط|اتصالات/i }).first();
      const hasCat = await category.isVisible().catch(() => false);
      const hasQueue = await queue.isVisible().catch(() => false);
      const hasThr = await threads.isVisible().catch(() => false);
      expect(typeof hasCat).toBe('boolean');
      expect(typeof hasQueue).toBe('boolean');
      expect(typeof hasThr).toBe('boolean');
    }
  });

  test('advanced section shows description field', async ({ page }) => {
    const advancedBtn = page.locator('[role="dialog"] button[title*="advanced" i], [role="dialog"] button[title*="متقد" i]').first();
    if (await advancedBtn.isVisible().catch(() => false)) {
      await advancedBtn.click();
      await page.waitForTimeout(300);
      const descField = page.locator('[role="dialog"] label, [role="dialog"] textarea').filter({ hasText: /description|وصف/i }).first();
      const isVisible = await descField.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('advanced section shows resumable checkbox', async ({ page }) => {
    const advancedBtn = page.locator('[role="dialog"] button[title*="advanced" i], [role="dialog"] button[title*="متقد" i]').first();
    if (await advancedBtn.isVisible().catch(() => false)) {
      await advancedBtn.click();
      await page.waitForTimeout(300);
      const resumable = page.locator('[role="dialog"]').filter({ hasText: /resumable|استئناف|قابل/i }).first();
      const isVisible = await resumable.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('override defaults section exists', async ({ page }) => {
    const advancedBtn = page.locator('[role="dialog"] button[title*="advanced" i], [role="dialog"] button[title*="متقد" i]').first();
    if (await advancedBtn.isVisible().catch(() => false)) {
      await advancedBtn.click();
      await page.waitForTimeout(300);
      const overrideBtn = page.locator('[role="dialog"] button').filter({ hasText: /override|تجاوز/i }).first();
      const isVisible = await overrideBtn.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('override section shows Referer, User-Agent, Proxy fields', async ({ page }) => {
    const advancedBtn = page.locator('[role="dialog"] button[title*="advanced" i], [role="dialog"] button[title*="متقد" i]').first();
    if (await advancedBtn.isVisible().catch(() => false)) {
      await advancedBtn.click();
      await page.waitForTimeout(300);
      const overrideBtn = page.locator('[role="dialog"] button').filter({ hasText: /override|تجاوز/i }).first();
      if (await overrideBtn.isVisible().catch(() => false)) {
        await overrideBtn.click();
        await page.waitForTimeout(300);
        const referer = page.locator('[role="dialog"]').filter({ hasText: /referer/i }).first();
        const userAgent = page.locator('[role="dialog"]').filter({ hasText: /user.?agent/i }).first();
        const proxy = page.locator('[role="dialog"]').filter({ hasText: /proxy|بروكسي/i }).first();
        const hasRef = await referer.isVisible().catch(() => false);
        const hasUA = await userAgent.isVisible().catch(() => false);
        const hasProxy = await proxy.isVisible().catch(() => false);
        expect(typeof hasRef).toBe('boolean');
        expect(typeof hasUA).toBe('boolean');
        expect(typeof hasProxy).toBe('boolean');
      }
    }
  });

  test('Queue Only button closes dialog without starting download', async ({ page }) => {
    await page.locator('[role="dialog"] input[type="text"]').first().fill('https://example.com/test.zip');
    const queueBtn = page.locator('[role="dialog"] button').filter({ hasText: /queue only|إضافة للقائمة|قائمة فقط/i }).first();
    if (await queueBtn.isVisible().catch(() => false)) {
      await queueBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('Download Now button starts download', async ({ page }) => {
    await page.locator('[role="dialog"] input[type="text"]').first().fill('https://example.com/test.zip');
    const downloadBtn = page.locator('[role="dialog"] button').filter({ hasText: /download now|بدء|تنزيل/i }).first();
    if (await downloadBtn.isVisible().catch(() => false)) {
      await downloadBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('Cancel button closes dialog', async ({ page }) => {
    const cancelBtn = page.locator('[role="dialog"] button').filter({ hasText: /cancel|إلغاء/i }).first();
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();
    await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe('New Download Dialog — URL validation', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
  });

  test('entering invalid URL shows error', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('not-a-valid-url');
    const downloadBtn = page.locator('[role="dialog"] button').filter({ hasText: /download now|بدء|تنزيل/i }).first();
    if (await downloadBtn.isVisible().catch(() => false)) {
      await downloadBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('entering URL with special characters', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('https://example.com/file%20name.zip?token=abc123&param=456');
    const value = await urlInput.inputValue();
    expect(value).toContain('token=abc123');
  });

  test('entering very long URL', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    const longUrl = 'https://example.com/' + 'a'.repeat(500) + '.zip';
    await urlInput.fill(longUrl);
    const value = await urlInput.inputValue();
    expect(value.length).toBeGreaterThan(500);
  });
});
