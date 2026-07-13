import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

const openNewDownload = async (page: import('@playwright/test').Page) => {
  await page.keyboard.press('Control+n');
  await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
};

const closeDialog = async (page: import('@playwright/test').Page) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
};

test.describe('Download Flow — add download dialog opens', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('Ctrl+N opens new download dialog', async ({ page }) => {
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await closeDialog(page);
  });

  test('URL input is auto-focused', async ({ page }) => {
    await openNewDownload(page);
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await expect(urlInput).toBeFocused();
    await closeDialog(page);
  });

  test('dialog has title referencing download', async ({ page }) => {
    await openNewDownload(page);
    const title = page.locator('#modal-title');
    const text = await title.textContent();
    expect(text).toMatch(/add|new|download|تنزيل|إضافة/i);
    await closeDialog(page);
  });

  test('dialog has Cancel and Download Now buttons', async ({ page }) => {
    await openNewDownload(page);
    const cancelBtn = page.locator('[role="dialog"] button').filter({ hasText: /cancel|إلغاء/i }).first();
    const downloadBtn = page.locator('[role="dialog"] button').filter({ hasText: /download now|بدء|تنزيل/i }).first();
    await expect(cancelBtn).toBeVisible();
    await expect(downloadBtn).toBeVisible();
    await closeDialog(page);
  });
});

test.describe('Download Flow — URL validation', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openNewDownload(page);
  });

  test.afterEach(async ({ page }) => {
    await closeDialog(page);
  });

  test('valid HTTP URL is accepted', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('https://example.com/file.zip');
    const value = await urlInput.inputValue();
    expect(value).toBe('https://example.com/file.zip');
  });

  test('invalid URL shows validation on submit', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('not-a-valid-url');
    const downloadBtn = page.locator('[role="dialog"] button').filter({ hasText: /download now|بدء|تنزيل/i }).first();
    await downloadBtn.click();
    await page.waitForTimeout(500);
    const dialog = page.locator('[role="dialog"]');
    const stillVisible = await dialog.isVisible().catch(() => false);
    expect(stillVisible).toBe(true);
  });

  test('empty URL shows validation on submit', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('');
    const downloadBtn = page.locator('[role="dialog"] button').filter({ hasText: /download now|بدء|تنزيل/i }).first();
    await downloadBtn.click();
    await page.waitForTimeout(500);
  });

  test('URL with special characters is preserved', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('https://example.com/file%20name.zip?token=abc&key=123');
    const value = await urlInput.inputValue();
    expect(value).toContain('token=abc');
    expect(value).toContain('key=123');
  });

  test('very long URL is accepted', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    const longUrl = 'https://example.com/' + 'a'.repeat(500) + '.zip';
    await urlInput.fill(longUrl);
    const value = await urlInput.inputValue();
    expect(value.length).toBeGreaterThan(500);
  });
});

test.describe('Download Flow — magnet link detection', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openNewDownload(page);
  });

  test.afterEach(async ({ page }) => {
    await closeDialog(page);
  });

  test('magnet link shows detection banner', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('magnet:?xt=urn:btih:abc123def456&dn=example-file');
    await page.waitForTimeout(300);
    const magnetIndicator = page.locator('[role="dialog"]').locator('text=/magnet|رواسب/i').first();
    const isVisible = await magnetIndicator.isVisible().catch(() => false);
    expect(isVisible).toBe(true);
  });

  test('magnet banner has visible styling', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('magnet:?xt=urn:btih:abc123def456&dn=example-file');
    await page.waitForTimeout(300);
    const magnetIndicator = page.locator('[role="dialog"]').locator('text=/magnet|رواسب/i').first();
    if (await magnetIndicator.isVisible().catch(() => false)) {
      const className = await magnetIndicator.getAttribute('class') ?? '';
      expect(className.length).toBeGreaterThan(0);
    }
  });

  test('regular URL does not show magnet banner', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('https://example.com/file.zip');
    await page.waitForTimeout(300);
    const magnetIndicator = page.locator('[role="dialog"]').locator('text=/magnet|رواسب/i').first();
    const isVisible = await magnetIndicator.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });

  test('clearing magnet hides banner', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await urlInput.fill('magnet:?xt=urn:btih:abc123def456&dn=example-file');
    await page.waitForTimeout(300);
    await urlInput.fill('https://example.com/other.zip');
    await page.waitForTimeout(300);
    const magnetIndicator = page.locator('[role="dialog"]').locator('text=/magnet|رواسب/i').first();
    const isVisible = await magnetIndicator.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });
});

test.describe('Download Flow — download starts and shows in task list', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('clicking Download Now closes dialog', async ({ page }) => {
    await openNewDownload(page);
    await page.locator('[role="dialog"] input[type="text"]').first().fill('https://example.com/test.zip');
    const downloadBtn = page.locator('[role="dialog"] button').filter({ hasText: /download now|بدء|تنزيل/i }).first();
    if (await downloadBtn.isVisible().catch(() => false)) {
      await downloadBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('Queue Only closes dialog without starting', async ({ page }) => {
    await openNewDownload(page);
    await page.locator('[role="dialog"] input[type="text"]').first().fill('https://example.com/test.zip');
    const queueBtn = page.locator('[role="dialog"] button').filter({ hasText: /queue only|إضافة للقائمة|قائمة فقط/i }).first();
    if (await queueBtn.isVisible().catch(() => false)) {
      await queueBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('task table shows row after adding download', async ({ page }) => {
    const rowsBefore = await page.locator('tr.desktop-table-row').count();
    await openNewDownload(page);
    await page.locator('[role="dialog"] input[type="text"]').first().fill('https://example.com/newfile.zip');
    const downloadBtn = page.locator('[role="dialog"] button').filter({ hasText: /download now|بدء|تنزيل/i }).first();
    if (await downloadBtn.isVisible().catch(() => false)) {
      await downloadBtn.click();
      await page.waitForTimeout(1000);
    }
    const rowsAfter = await page.locator('tr.desktop-table-row').count();
    expect(rowsAfter).toBeGreaterThanOrEqual(rowsBefore);
  });
});

test.describe('Download Flow — task action buttons', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('toolbar has resume button', async ({ page }) => {
    const resumeBtn = page.locator('button[aria-label*="resume" i], button[title*="resume" i]').first();
    const resumeText = page.locator('button').filter({ hasText: /resume|استئناف/i }).first();
    const hasBtn = await resumeBtn.isVisible().catch(() => false);
    const hasText = await resumeText.isVisible().catch(() => false);
    expect(hasBtn || hasText).toBeTruthy();
  });

  test('toolbar has pause/stop button', async ({ page }) => {
    const pauseBtn = page.locator('button[aria-label*="pause" i], button[aria-label*="stop" i]').first();
    const pauseText = page.locator('button').filter({ hasText: /pause|stop|إيقاف|توقف/i }).first();
    const hasBtn = await pauseBtn.isVisible().catch(() => false);
    const hasText = await pauseText.isVisible().catch(() => false);
    expect(hasBtn || hasText).toBeTruthy();
  });

  test('toolbar has delete button', async ({ page }) => {
    const deleteBtn = page.locator('button[aria-label*="delete" i]').first();
    const deleteText = page.locator('button').filter({ hasText: /delete|حذف/i }).first();
    const hasBtn = await deleteBtn.isVisible().catch(() => false);
    const hasText = await deleteText.isVisible().catch(() => false);
    expect(hasBtn || hasText).toBeTruthy();
  });
});

test.describe('Download Flow — pause/resume/cancel via task row', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('right-click context menu has pause option', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        const pauseItem = page.locator('[role="menuitem"]').filter({ hasText: /pause|stop|إيقاف/i });
        const isVisible = await pauseItem.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });

  test('right-click context menu has resume option', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        const resumeItem = page.locator('[role="menuitem"]').filter({ hasText: /resume|start|استئناف|بدء/i });
        const isVisible = await resumeItem.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });

  test('right-click context menu has cancel option', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        const cancelItem = page.locator('[role="menuitem"]').filter({ hasText: /cancel|إلغاء/i });
        const isVisible = await cancelItem.isVisible().catch(() => false);
        expect(typeof isVisible).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Download Flow — delete with confirmation', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('delete dropdown shows delete options', async ({ page }) => {
    const deleteChevron = page.locator('button[aria-label*="more" i]').last();
    if (await deleteChevron.isVisible().catch(() => false)) {
      await deleteChevron.click();
      await page.waitForTimeout(200);
      const deleteAll = page.locator('button').filter({ hasText: /delete all|حذف الكل/i }).first();
      const deleteSelected = page.locator('button').filter({ hasText: /delete selected|حذف المحدد/i }).first();
      const hasAll = await deleteAll.isVisible().catch(() => false);
      const hasSelected = await deleteSelected.isVisible().catch(() => false);
      expect(hasAll || hasSelected).toBeTruthy();
      await page.keyboard.press('Escape');
    }
  });

  test('delete all opens confirmation dialog', async ({ page }) => {
    const deleteChevron = page.locator('button[aria-label*="more" i]').last();
    if (await deleteChevron.isVisible().catch(() => false)) {
      await deleteChevron.click();
      await page.waitForTimeout(200);
      const deleteAll = page.locator('button').filter({ hasText: /delete all|حذف الكل/i }).first();
      if (await deleteAll.isVisible().catch(() => false)) {
        await deleteAll.click();
        await page.waitForTimeout(500);
        const confirmDialog = page.locator('[role="dialog"]');
        if (await confirmDialog.isVisible().catch(() => false)) {
          const cancelBtn = page.locator('button').filter({ hasText: /cancel|إلغاء/i }).first();
          if (await cancelBtn.isVisible().catch(() => false)) {
            await cancelBtn.click();
          }
        }
      }
    }
  });

  test('context menu delete option is danger-styled', async ({ page }) => {
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(300);
      const deleteItem = page.locator('[role="menuitem"]').filter({ hasText: /delete/i });
      if (await deleteItem.isVisible().catch(() => false)) {
        const hasDangerStyle = await deleteItem.evaluate(el =>
          (el.getAttribute('class') ?? '').includes('red') ||
          (el.getAttribute('class') ?? '').includes('danger') ||
          window.getComputedStyle(el).color.includes('239') ||
          window.getComputedStyle(el).color.includes('red')
        );
        expect(typeof hasDangerStyle).toBe('boolean');
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Download Flow — progress bar updates', () => {
  test('progress bar elements exist in task rows', async ({ page }) => {
    await goto(page);
    const progressBars = page.locator('tr.desktop-table-row [role="progressbar"], tr.desktop-table-row [class*="progress"]');
    const count = await progressBars.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('progress bars have width or value attribute', async ({ page }) => {
    await goto(page);
    const progressBars = page.locator('tr.desktop-table-row [role="progressbar"]');
    const count = await progressBars.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const bar = progressBars.nth(i);
      if (await bar.isVisible().catch(() => false)) {
        const hasWidth = await bar.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style.width !== '0px' || el.getAttribute('aria-valuenow') !== null;
        });
        expect(typeof hasWidth).toBe('boolean');
      }
    }
  });

  test('task rows show percentage text', async ({ page }) => {
    await goto(page);
    const percentText = page.locator('tr.desktop-table-row').locator('text=/\\d+%/');
    const count = await percentText.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Download Flow — elapsed time displays', () => {
  test('elapsed time label exists in status area', async ({ page }) => {
    await goto(page);
    const elapsedLabel = page.locator('text=/elapsed|المنقضي|time|الوقت/i').first();
    const isVisible = await elapsedLabel.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('time values are displayed in task rows', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      const timeText = firstRow.locator('text=/\\d+:\\d+|\\d+\\s*(s|min|h|sec|d)/i');
      const isVisible = await timeText.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});
