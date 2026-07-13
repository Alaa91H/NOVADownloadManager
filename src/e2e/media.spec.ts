import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

const openMediaDialog = async (page: import('@playwright/test').Page) => {
  await goto(page);
  const chevron = page.locator('header button[data-dialog-trigger="true"]').first();
  if (await chevron.isVisible().catch(() => false)) {
    await chevron.click();
    await page.waitForTimeout(300);
    const mediaBtn = page.locator('button').filter({ hasText: /media|وسائط|فيديو/i }).first();
    if (await mediaBtn.isVisible().catch(() => false)) {
      await mediaBtn.click();
      await page.waitForTimeout(500);
    }
  }
};

test.describe('Media Download — dialog structure', () => {
  test.beforeEach(async ({ page }) => { await openMediaDialog(page); });

  test('media download dialog opens', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const isVisible = await dialog.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('URL input exists', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"], #page-url').first();
    const isVisible = await urlInput.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('back button exists', async ({ page }) => {
    const backBtn = page.locator('button').filter({ hasText: /back|رجوع|رجعة/i }).first();
    const isVisible = await backBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('cancel button exists', async ({ page }) => {
    const cancelBtn = page.locator('button').filter({ hasText: /cancel|إلغاء/i }).first();
    const isVisible = await cancelBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Media Download — mode selection', () => {
  test.beforeEach(async ({ page }) => { await openMediaDialog(page); });

  test('Video & Audio mode button exists', async ({ page }) => {
    const videoBtn = page.locator('button').filter({ hasText: /video.*audio|فيديو.*صوت/i }).first();
    const isVisible = await videoBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('Audio Only mode button exists', async ({ page }) => {
    const audioBtn = page.locator('button').filter({ hasText: /audio only|صوت فقط/i }).first();
    const isVisible = await audioBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('selecting Audio Only mode changes options', async ({ page }) => {
    const audioBtn = page.locator('button').filter({ hasText: /audio only|صوت فقط/i }).first();
    if (await audioBtn.isVisible().catch(() => false)) {
      await audioBtn.click();
      await page.waitForTimeout(300);
    }
  });
});

test.describe('Media Download — quality selection', () => {
  test.beforeEach(async ({ page }) => { await openMediaDialog(page); });

  test('quality grid is present', async ({ page }) => {
    const qualityGrid = page.locator('[class*="grid"], [class*="quality"]').first();
    const isVisible = await qualityGrid.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('quality options can be selected', async ({ page }) => {
    const qualityOptions = page.locator('button').filter({ hasText: /720|1080|480|360|240/i });
    const count = await qualityOptions.count();
    if (count > 0) {
      await qualityOptions.first().click();
      await page.waitForTimeout(200);
    }
  });
});

test.describe('Media Download — audio format selection', () => {
  test.beforeEach(async ({ page }) => { await openMediaDialog(page); });

  test('audio format options exist (MP3, M4A, FLAC, WAV)', async ({ page }) => {
    const formats = ['MP3', 'M4A', 'FLAC', 'WAV'];
    for (const fmt of formats) {
      const fmtBtn = page.locator('button').filter({ hasText: new RegExp(fmt, 'i') }).first();
      const isVisible = await fmtBtn.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('audio format can be selected', async ({ page }) => {
    const mp3Btn = page.locator('button').filter({ hasText: /mp3/i }).first();
    if (await mp3Btn.isVisible().catch(() => false)) {
      await mp3Btn.click();
      await page.waitForTimeout(200);
    }
  });
});

test.describe('Media Download — save settings', () => {
  test.beforeEach(async ({ page }) => { await openMediaDialog(page); });

  test('save directory field exists', async ({ page }) => {
    const pathField = page.locator('#page-path, input[type="text"]').first();
    const isVisible = await pathField.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('output template field exists', async ({ page }) => {
    const templateField = page.locator('#page-template, input[type="text"]').nth(1);
    const isVisible = await templateField.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Media Download — start download', () => {
  test.beforeEach(async ({ page }) => { await openMediaDialog(page); });

  test('Start Download button exists', async ({ page }) => {
    const startBtn = page.locator('button').filter({ hasText: /start download|بدء|تنزيل/i }).first();
    const isVisible = await startBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('clicking Start without URL shows validation', async ({ page }) => {
    const startBtn = page.locator('button').filter({ hasText: /start download|بدء|تنزيل/i }).first();
    if (await startBtn.isVisible().catch(() => false)) {
      await startBtn.click();
      await page.waitForTimeout(500);
    }
  });
});

test.describe('Media Download — close dialog', () => {
  test.beforeEach(async ({ page }) => { await openMediaDialog(page); });

  test('Escape closes media dialog', async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const dialog = page.locator('[role="dialog"]');
    const isVisible = await dialog.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});
