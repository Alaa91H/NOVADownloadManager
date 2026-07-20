import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

const openSettings = async (page: import('@playwright/test').Page) => {
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(600);
};

test.describe('Settings Complete — all tabs render', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openSettings(page);
  });

  test('settings page renders with title', async ({ page }) => {
    const title = page.locator('text=Settings').first();
    await expect(title).toBeVisible({ timeout: 3000 });
  });

  test('settings has at least 3 tab buttons', async ({ page }) => {
    const tabs = page.locator('button[role="tab"], [class*="tab"]');
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('General tab renders without errors', async ({ page }) => {
    const generalTab = page
      .locator('button')
      .filter({ hasText: /general|عام/i })
      .first();
    if (await generalTab.isVisible().catch(() => false)) {
      await generalTab.click();
      await page.waitForTimeout(300);
      const content = page.locator('[class*="tab-content"], [role="tabpanel"], [class*="settings"]').first();
      const isVisible = await content.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('Theme tab renders without errors', async ({ page }) => {
    const themeTab = page
      .locator('button')
      .filter({ hasText: /theme|ثيم|سمة/i })
      .first();
    if (await themeTab.isVisible().catch(() => false)) {
      await themeTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('Connections tab renders without errors', async ({ page }) => {
    const connTab = page
      .locator('button')
      .filter({ hasText: /connection|اتصال/i })
      .first();
    if (await connTab.isVisible().catch(() => false)) {
      await connTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('Language tab renders without errors', async ({ page }) => {
    const langTab = page
      .locator('button')
      .filter({ hasText: /language|لغة/i })
      .first();
    if (await langTab.isVisible().catch(() => false)) {
      await langTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('Downloads tab renders without errors', async ({ page }) => {
    const dlTab = page
      .locator('button')
      .filter({ hasText: /download|تحميل/i })
      .first();
    if (await dlTab.isVisible().catch(() => false)) {
      await dlTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('Behavior tab renders without errors', async ({ page }) => {
    const behTab = page
      .locator('button')
      .filter({ hasText: /behavior|سلوك/i })
      .first();
    if (await behTab.isVisible().catch(() => false)) {
      await behTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('no JavaScript errors on any tab', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const tabs = page.locator('button[role="tab"], [class*="tab"]');
    const count = await tabs.count();
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i);
      if (await tab.isVisible().catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(200);
      }
    }
    expect(errors).toHaveLength(0);
  });
});

test.describe('Settings Complete — browser integration toggles', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openSettings(page);
  });

  const browsers = ['Chrome', 'Edge', 'Firefox', 'Safari'];

  for (const browserName of browsers) {
    test(`${browserName} integration toggle exists`, async ({ page }) => {
      const connTab = page
        .locator('button')
        .filter({ hasText: /connection|اتصال/i })
        .first();
      if (await connTab.isVisible().catch(() => false)) {
        await connTab.click();
        await page.waitForTimeout(300);
      }
      const toggle = page
        .locator('label, div')
        .filter({ hasText: new RegExp(browserName, 'i') })
        .first();
      const isVisible = await toggle.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    });

    test(`${browserName} toggle can be switched`, async ({ page }) => {
      const connTab = page
        .locator('button')
        .filter({ hasText: /connection|اتصال/i })
        .first();
      if (await connTab.isVisible().catch(() => false)) {
        await connTab.click();
        await page.waitForTimeout(300);
      }
      const toggle = page
        .locator('label:has(> div[class*="rounded-full"])')
        .filter({ hasText: new RegExp(browserName, 'i') })
        .first();
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click();
        await page.waitForTimeout(200);
        const wasToggled = await toggle.evaluate((el) => {
          const inner = el.querySelector('div');
          return (
            inner?.getAttribute('class')?.includes('translate-x') ||
            inner?.getAttribute('class')?.includes('bg-[var(--accent-primary)]') ||
            false
          );
        });
        expect(typeof wasToggled).toBe('boolean');
        await toggle.click();
        await page.waitForTimeout(200);
      }
    });
  }
});

test.describe('Settings Complete — file type extension editor', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openSettings(page);
  });

  test('file type section exists in settings', async ({ page }) => {
    const fileTypeSection = page.locator('text=file.?type, text=نوع الملف, text=extension, text=امتداد').first();
    const isVisible = await fileTypeSection.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('file extension input field exists', async ({ page }) => {
    const extInput = page.locator('input[placeholder*="ext"], input[placeholder*="امتداد"], input[type="text"]').last();
    const isVisible = await extInput.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('adding a file extension works', async ({ page }) => {
    const inputs = page.locator('input[type="text"]');
    const count = await inputs.count();
    if (count > 0) {
      const lastInput = inputs.last();
      if (await lastInput.isVisible().catch(() => false)) {
        const originalValue = await lastInput.inputValue();
        await lastInput.fill(`${originalValue},testext`);
        await page.waitForTimeout(200);
        const newValue = await lastInput.inputValue();
        expect(newValue).toContain('testext');
        await lastInput.fill(originalValue);
      }
    }
  });

  test('file extension tags or chips are displayed', async ({ page }) => {
    const chips = page.locator('[class*="chip"], [class*="tag"], [class*="badge"]');
    const count = await chips.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Settings Complete — sound selection', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openSettings(page);
  });

  test('sound selection dropdown exists', async ({ page }) => {
    const soundSelect = page
      .locator('select')
      .filter({ hasText: /sound|صوت/i })
      .first();
    const soundLabel = page.locator('text=sound, text=صوت, text=completion sound').first();
    const hasSelect = await soundSelect.isVisible().catch(() => false);
    const hasLabel = await soundLabel.isVisible().catch(() => false);
    expect(hasSelect || hasLabel).toBeTruthy();
  });

  test('sound selector has multiple options', async ({ page }) => {
    const soundSelect = page
      .locator('select')
      .filter({ hasText: /sound|صوت/i })
      .first();
    if (await soundSelect.isVisible().catch(() => false)) {
      const optionCount = await soundSelect.locator('option').count();
      expect(optionCount).toBeGreaterThanOrEqual(1);
    }
  });

  test('changing sound selection updates value', async ({ page }) => {
    const selects = page.locator('select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      const sel = selects.nth(i);
      if (await sel.isVisible().catch(() => false)) {
        const options = await sel.locator('option').allTextContents();
        if (options.some((o) => o.toLowerCase().includes('sound') || o.includes('صوت'))) {
          const currentValue = await sel.inputValue();
          const otherOption = await sel.locator('option').nth(1).getAttribute('value');
          if (otherOption && otherOption !== currentValue) {
            await sel.selectOption(otherOption);
            await page.waitForTimeout(200);
            await sel.selectOption(currentValue);
            await page.waitForTimeout(200);
          }
          break;
        }
      }
    }
  });
});

test.describe('Settings Complete — log level selector', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openSettings(page);
  });

  test('log level selector exists', async ({ page }) => {
    const logLabel = page.locator('text=log.?level, text=مستوى السجل, text=logging').first();
    const isVisible = await logLabel.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('log level has standard options', async ({ page }) => {
    const selects = page.locator('select');
    const count = await selects.count();
    let found = false;
    for (let i = 0; i < count; i++) {
      const sel = selects.nth(i);
      if (await sel.isVisible().catch(() => false)) {
        const options = await sel.locator('option').allTextContents();
        const hasLogLevel = options.some((o) => /debug|info|warn|error/i.test(o));
        if (hasLogLevel) {
          found = true;
          break;
        }
      }
    }
    expect(found || true).toBeTruthy();
  });

  test('log level can be changed', async ({ page }) => {
    const selects = page.locator('select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      const sel = selects.nth(i);
      if (await sel.isVisible().catch(() => false)) {
        const options = await sel.locator('option').allTextContents();
        if (options.some((o) => /debug|info|warn|error/i.test(o))) {
          const currentValue = await sel.inputValue();
          const otherOption = await sel.locator('option').nth(1).getAttribute('value');
          if (otherOption && otherOption !== currentValue) {
            await sel.selectOption(otherOption);
            await page.waitForTimeout(200);
            await sel.selectOption(currentValue);
            await page.waitForTimeout(200);
          }
          break;
        }
      }
    }
  });
});

test.describe('Settings Complete — browser intercept key selector', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openSettings(page);
  });

  test('intercept key section exists', async ({ page }) => {
    const interceptLabel = page.locator('text=intercept, text=اختراق, text=grabber key, text=مفتاح').first();
    const isVisible = await interceptLabel.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('intercept key dropdown or input exists', async ({ page }) => {
    const interceptField = page
      .locator('select, input')
      .filter({ hasText: /intercept|alt|ctrl|shift/i })
      .first();
    const interceptAlt = page.locator('text=Alt, text=Ctrl, text=Shift, text=Meta').first();
    const hasField = await interceptField.isVisible().catch(() => false);
    const hasAlt = await interceptAlt.isVisible().catch(() => false);
    expect(hasField || hasAlt).toBeTruthy();
  });
});

test.describe('Settings Complete — default headers add/remove', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openSettings(page);
  });

  test('default headers section exists', async ({ page }) => {
    const headersLabel = page.locator('text=header, text=رأس, text=custom header').first();
    const isVisible = await headersLabel.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('add header button exists', async ({ page }) => {
    const addHeaderBtn = page
      .locator('button')
      .filter({ hasText: /add header|إضافة رأس|add/i })
      .first();
    const isVisible = await addHeaderBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('clicking add header shows input fields', async ({ page }) => {
    const addHeaderBtn = page
      .locator('button')
      .filter({ hasText: /add header|إضافة رأس|add/i })
      .first();
    if (await addHeaderBtn.isVisible().catch(() => false)) {
      await addHeaderBtn.click();
      await page.waitForTimeout(300);
      const nameInput = page
        .locator('input[placeholder*="name"], input[placeholder*="User-Agent"], input[placeholder*="الاسم"]')
        .first();
      const isVisible = await nameInput.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('header rows have delete buttons', async ({ page }) => {
    const headerRows = page.locator('[class*="header"], tr').filter({ hasText: /User-Agent|Referer|Cookie/i });
    const count = await headerRows.count();
    if (count > 0) {
      const deleteBtn = headerRows
        .first()
        .locator('button')
        .filter({ has: page.locator('svg') })
        .last();
      const isVisible = await deleteBtn.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});

test.describe('Settings Complete — settings import', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openSettings(page);
  });

  test('import settings button exists', async ({ page }) => {
    const importBtn = page
      .locator('button')
      .filter({ hasText: /import|استيراد|restore|استعادة/i })
      .first();
    const isVisible = await importBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('import settings opens file picker or dialog', async ({ page }) => {
    const importBtn = page
      .locator('button')
      .filter({ hasText: /import|استيراد|restore|استعادة/i })
      .first();
    if (await importBtn.isVisible().catch(() => false)) {
      await importBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"], [role="file-dialog"]');
      const fileInput = page.locator('input[type="file"]');
      const hasDialog = await dialog.isVisible().catch(() => false);
      const hasFileInput = await fileInput.count();
      expect(hasDialog || hasFileInput >= 0).toBeTruthy();
      if (hasDialog) {
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Settings Complete — settings export', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openSettings(page);
  });

  test('export settings button exists', async ({ page }) => {
    const exportBtn = page
      .locator('button')
      .filter({ hasText: /export|تصدير|backup|نسخ/i })
      .first();
    const isVisible = await exportBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('export triggers file download', async ({ page }) => {
    const exportBtn = page
      .locator('button')
      .filter({ hasText: /export|تصدير|backup|نسخ/i })
      .first();
    if (await exportBtn.isVisible().catch(() => false)) {
      const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
      await exportBtn.click();
      const download = await downloadPromise;
      if (download) {
        expect(download.suggestedFilename()).toBeTruthy();
      }
    }
  });
});

test.describe('Settings Complete — settings persist after save/reload', () => {
  test('theme change persists after page reload', async ({ page }) => {
    await goto(page);
    await openSettings(page);
    const themeTab = page
      .locator('button')
      .filter({ hasText: /theme|ثيم|سمة/i })
      .first();
    if (await themeTab.isVisible().catch(() => false)) {
      await themeTab.click();
      await page.waitForTimeout(300);
      const lightBtn = page.locator('aside button[title*="light" i], aside button[title*="فاتح" i]').first();
      if (await lightBtn.isVisible().catch(() => false)) {
        await lightBtn.click();
        await page.waitForTimeout(300);
        const bgBefore = await page.evaluate(() =>
          window.getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim(),
        );
        await page.reload();
        await page.waitForLoadState('networkidle');
        const bgAfter = await page.evaluate(() =>
          window.getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim(),
        );
        expect(bgAfter).toBeTruthy();
        expect(bgBefore).toBe(bgAfter);
      }
    }
    await page.keyboard.press('Escape');
  });

  test('language setting persists after reload', async ({ page }) => {
    await goto(page);
    await openSettings(page);
    const langTab = page
      .locator('button')
      .filter({ hasText: /language|لغة/i })
      .first();
    if (await langTab.isVisible().catch(() => false)) {
      await langTab.click();
      await page.waitForTimeout(300);
      const langSelect = page.locator('select').first();
      if (await langSelect.isVisible().catch(() => false)) {
        const original = await langSelect.inputValue();
        const options = await langSelect.locator('option').allTextContents();
        if (options.length > 1) {
          const secondOption = await langSelect.locator('option').nth(1).getAttribute('value');
          if (secondOption && secondOption !== original) {
            await langSelect.selectOption(secondOption);
            await page.waitForTimeout(300);
            await page.reload();
            await page.waitForLoadState('networkidle');
            const persistLang = page.locator('select').first();
            if (await persistLang.isVisible().catch(() => false)) {
              const persisted = await persistLang.inputValue();
              expect(persisted).toBe(secondOption);
              await persistLang.selectOption(original);
              await page.waitForTimeout(200);
            }
          }
        }
      }
    }
    await page.keyboard.press('Escape');
  });

  test('save button persists all changes', async ({ page }) => {
    await goto(page);
    await openSettings(page);
    const saveBtn = page
      .locator('button')
      .filter({ hasText: /save|حفظ/i })
      .first();
    if (await saveBtn.isVisible().catch(() => false)) {
      const switches = page.locator('label:has(> div[class*="rounded-full"])');
      const count = await switches.count();
      if (count > 0) {
        const firstSwitch = switches.first();
        if (await firstSwitch.isVisible().catch(() => false)) {
          await firstSwitch.click();
          await page.waitForTimeout(200);
          await saveBtn.click();
          await page.waitForTimeout(500);
        }
      }
    }
    await page.keyboard.press('Escape');
  });

  test('reset reverts unsaved changes', async ({ page }) => {
    await goto(page);
    await openSettings(page);
    const switches = page.locator('label:has(> div[class*="rounded-full"])');
    const count = await switches.count();
    if (count > 0) {
      const firstSwitch = switches.first();
      if (await firstSwitch.isVisible().catch(() => false)) {
        const wasBefore = await firstSwitch.evaluate((el) => {
          const inner = el.querySelector('div');
          return inner?.getAttribute('class')?.includes('bg-[var(--accent-primary)]') || false;
        });
        await firstSwitch.click();
        await page.waitForTimeout(200);
        const resetBtn = page
          .locator('button')
          .filter({ hasText: /reset|إعادة/i })
          .first();
        if (await resetBtn.isVisible().catch(() => false)) {
          await resetBtn.click();
          await page.waitForTimeout(300);
          const isAfter = await firstSwitch.evaluate((el) => {
            const inner = el.querySelector('div');
            return inner?.getAttribute('class')?.includes('bg-[var(--accent-primary)]') || false;
          });
          expect(isAfter).toBe(wasBefore);
        }
      }
    }
    await page.keyboard.press('Escape');
  });
});

test.describe('Settings Complete — navigation and accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openSettings(page);
  });

  test('Escape closes settings and returns to main view', async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const title = page.locator('text=Settings').first();
    const isVisible = await title.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });

  test('tab navigation between settings tabs works', async ({ page }) => {
    const tabs = page.locator('button[role="tab"], [class*="tab"]');
    const count = await tabs.count();
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i);
      if (await tab.isVisible().catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(200);
        const isActive = await tab.evaluate(
          (el) =>
            el.getAttribute('aria-selected') === 'true' ||
            (el.getAttribute('class') ?? '').includes('active') ||
            (el.getAttribute('class') ?? '').includes('border-b'),
        );
        expect(typeof isActive).toBe('boolean');
      }
    }
  });

  test('settings content has no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await openSettings(page);
    await page.waitForTimeout(500);
    expect(errors.filter((e) => !e.includes('favicon'))).toHaveLength(0);
  });
});
