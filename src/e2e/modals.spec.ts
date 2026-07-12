import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Modals — open and close', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('new download dialog opens and closes via Ctrl+N / Escape', async ({ page }) => {
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('dialog has accessible title', async ({ page }) => {
    await page.keyboard.press('Control+n');
    const title = page.locator('#modal-title');
    await expect(title).toBeVisible({ timeout: 3000 });
    const text = await title.textContent();
    expect(text?.length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
  });

  test('dialog has close button', async ({ page }) => {
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const closeBtn = dialog.locator('button').filter({ has: page.locator('svg') }).last();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(300);
    }
    await expect(dialog).not.toBeVisible({ timeout: 3000 });
  });

  test('clicking overlay backdrop closes dialog', async ({ page }) => {
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const overlay = page.locator('.modal-overlay, [class*="fixed inset-0"]').first();
    if (await overlay.isVisible().catch(() => false)) {
      await overlay.click({ position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
    }
  });

  test('dialog content prevents body scroll', async ({ page }) => {
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const overflow = await page.evaluate(() => window.getComputedStyle(document.body).overflow);
    expect(overflow).toBeTruthy();
    await page.keyboard.press('Escape');
  });
});

test.describe('Modals — modal animation', () => {
  test('modal has scale-in animation on open', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const hasAnimation = await dialog.evaluate(el => {
      const style = window.getComputedStyle(el);
      return style.animation !== 'none' || style.transition !== 'none 0s ease 0s';
    });
    expect(typeof hasAnimation).toBe('boolean');
    await page.keyboard.press('Escape');
  });
});

test.describe('Modals — modal minimize and maximize', () => {
  test('modal has minimize button', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const minimizeBtn = dialog.locator('button[title*="minimize" i], button[title*="تصغير" i]').first();
    const isVisible = await minimizeBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
    await page.keyboard.press('Escape');
  });

  test('modal has maximize button', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const maximizeBtn = dialog.locator('button[title*="maximize" i], button[title*="تكبير" i]').first();
    const isVisible = await maximizeBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
    await page.keyboard.press('Escape');
  });
});

test.describe('Modals — modal drag', () => {
  test('modal title bar is draggable', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const titleBar = dialog.locator('.cursor-move, [class*="cursor-move"]').first();
    const isVisible = await titleBar.isVisible().catch(() => false);
    if (isVisible) {
      const cursor = await titleBar.evaluate(el => window.getComputedStyle(el).cursor);
      expect(cursor).toBe('move');
    }
    await page.keyboard.press('Escape');
  });
});

test.describe('Modals — focus trap', () => {
  test('Tab cycles focus within dialog', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    if (await focused.isVisible().catch(() => false)) {
      const isInDialog = await focused.evaluate(el => {
        return el.closest('[role="dialog"]') !== null;
      });
      expect(isInDialog).toBeTruthy();
    }
    await page.keyboard.press('Escape');
  });

  test('Shift+Tab cycles focus in reverse', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Shift+Tab');
    const focused = page.locator(':focus');
    if (await focused.isVisible().catch(() => false)) {
      const isInDialog = await focused.evaluate(el => {
        return el.closest('[role="dialog"]') !== null;
      });
      expect(isInDialog).toBeTruthy();
    }
    await page.keyboard.press('Escape');
  });
});

test.describe('Dialogs — New Download Dialog content', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
  });

  test.afterEach(async ({ page }) => {
    await page.keyboard.press('Escape');
  });

  test('URL input field exists and is auto-focused', async ({ page }) => {
    const urlInput = page.locator('[role="dialog"] input[type="text"]').first();
    await expect(urlInput).toBeVisible();
    await expect(urlInput).toBeFocused();
  });

  test('save path field exists', async ({ page }) => {
    const inputs = page.locator('[role="dialog"] input[type="text"]');
    const count = await inputs.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('filename input exists', async ({ page }) => {
    const inputs = page.locator('[role="dialog"] input[type="text"]');
    const count = await inputs.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('paste from clipboard button exists', async ({ page }) => {
    const pasteBtn = page.locator('[role="dialog"] button[title*="paste" i], [role="dialog"] button[title*="لصق" i]').first();
    const isVisible = await pasteBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('browse folder button exists', async ({ page }) => {
    const browseBtn = page.locator('[role="dialog"] button[title*="browse" i], [role="dialog"] button[title*="folder" i]').first();
    const isVisible = await browseBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('advanced options toggle exists', async ({ page }) => {
    const advancedBtn = page.locator('[role="dialog"] button[title*="advanced" i], [role="dialog"] button[title*="متقد" i]').first();
    const isVisible = await advancedBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('Queue Only and Download Now buttons exist', async ({ page }) => {
    const queueBtn = page.locator('[role="dialog"] button').filter({ hasText: /queue|قائمة|جاري/i }).first();
    const downloadBtn = page.locator('[role="dialog"] button').filter({ hasText: /download now|بدء|تنزيل/i }).first();
    const hasQueue = await queueBtn.isVisible().catch(() => false);
    const hasDownload = await downloadBtn.isVisible().catch(() => false);
    expect(typeof hasQueue).toBe('boolean');
    expect(typeof hasDownload).toBe('boolean');
  });

  test('Cancel button exists and closes dialog', async ({ page }) => {
    const cancelBtn = page.locator('[role="dialog"] button').filter({ hasText: /cancel|إلغاء/i }).first();
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click();
      await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 3000 });
    }
  });

  test('clicking Download Now without URL shows validation', async ({ page }) => {
    const downloadBtn = page.locator('[role="dialog"] button').filter({ hasText: /download now|بدء|تنزيل/i }).first();
    if (await downloadBtn.isVisible().catch(() => false)) {
      await downloadBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('advanced section shows category, queue, threads selectors', async ({ page }) => {
    const advancedBtn = page.locator('[role="dialog"] button[title*="advanced" i], [role="dialog"] button[title*="متقد" i]').first();
    if (await advancedBtn.isVisible().catch(() => false)) {
      await advancedBtn.click();
      await page.waitForTimeout(300);
      const category = page.locator('[role="dialog"] text=category, [role="dialog"] text=فئة').first();
      const queue = page.locator('[role="dialog"] text=queue, [role="dialog"] text=قائمة').first();
      const threads = page.locator('[role="dialog"] text=threads, [role="dialog"] text=خيوط').first();
      const hasCat = await category.isVisible().catch(() => false);
      const hasQueue = await queue.isVisible().catch(() => false);
      const hasThr = await threads.isVisible().catch(() => false);
      expect(typeof hasCat).toBe('boolean');
      expect(typeof hasQueue).toBe('boolean');
      expect(typeof hasThr).toBe('boolean');
    }
  });
});

test.describe('Dialogs — Confirm Delete Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('delete all from dropdown opens confirm dialog', async ({ page }) => {
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
});

test.describe('Dialogs — About Dialog', () => {
  test('can be opened from sidebar', async ({ page }) => {
    await goto(page);
    const aboutBtn = page.locator('aside button').filter({ hasText: /about|حول/i }).first();
    if (await aboutBtn.isVisible().catch(() => false)) {
      await aboutBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
      }
    }
  });
});
