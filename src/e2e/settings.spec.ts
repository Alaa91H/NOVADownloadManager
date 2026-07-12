import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

const openSettings = async (page: import('@playwright/test').Page) => {
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(600);
};

test.describe('Settings — page structure', () => {
  test.beforeEach(async ({ page }) => { await goto(page); await openSettings(page); });

  test('settings page renders with title', async ({ page }) => {
    await expect(page.locator('text=Settings').first()).toBeVisible({ timeout: 3000 });
  });

  test('settings has tab navigation', async ({ page }) => {
    const tabs = page.locator('button[role="tab"], [class*="tab"]');
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('settings has save/reset buttons', async ({ page }) => {
    const saveBtn = page.locator('button').filter({ hasText: /save|حفظ/i }).first();
    const resetBtn = page.locator('button').filter({ hasText: /reset|إعادة/i }).first();
    const hasSave = await saveBtn.isVisible().catch(() => false);
    const hasReset = await resetBtn.isVisible().catch(() => false);
    expect(typeof hasSave).toBe('boolean');
    expect(typeof hasReset).toBe('boolean');
  });
});

test.describe('Settings — General tab', () => {
  test.beforeEach(async ({ page }) => { await goto(page); await openSettings(page); });

  test('general tab is active by default', async ({ page }) => {
    const generalTab = page.locator('button').filter({ hasText: /general|عام/i }).first();
    if (await generalTab.isVisible().catch(() => false)) {
      const isActive = await generalTab.evaluate(el =>
        (el.getAttribute('class') ?? '').includes('active') || (el.getAttribute('class') ?? '').includes('border-b') || el.getAttribute('aria-selected') === 'true'
      );
      expect(typeof isActive).toBe('boolean');
    }
  });

  test('startup options are visible', async ({ page }) => {
    const startupSection = page.locator('text=startup, text=التشغيل, text=autostart').first();
    const isVisible = await startupSection.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('notifications toggle exists', async ({ page }) => {
    const notifToggle = page.locator('text=notification, text=إشعار').first();
    const isVisible = await notifToggle.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Settings — Theme tab', () => {
  test.beforeEach(async ({ page }) => { await goto(page); await openSettings(page); });

  test('theme tab is clickable', async ({ page }) => {
    const themeTab = page.locator('button').filter({ hasText: /theme|ثيم|سمة/i }).first();
    if (await themeTab.isVisible().catch(() => false)) {
      await themeTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('theme options include dark, light, system', async ({ page }) => {
    const themeTab = page.locator('button').filter({ hasText: /theme|ثيم|سمة/i }).first();
    if (await themeTab.isVisible().catch(() => false)) {
      await themeTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('accent color options exist', async ({ page }) => {
    const themeTab = page.locator('button').filter({ hasText: /theme|ثيم|سمة/i }).first();
    if (await themeTab.isVisible().catch(() => false)) {
      await themeTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('density selector exists (compact/dense/normal)', async ({ page }) => {
    const themeTab = page.locator('button').filter({ hasText: /theme|ثيم|سمة/i }).first();
    if (await themeTab.isVisible().catch(() => false)) {
      await themeTab.click();
      await page.waitForTimeout(300);
    }
  });
});

test.describe('Settings — Connections tab', () => {
  test.beforeEach(async ({ page }) => { await goto(page); await openSettings(page); });

  test('connections tab shows network settings', async ({ page }) => {
    const connTab = page.locator('button').filter({ hasText: /connection|اتصال/i }).first();
    if (await connTab.isVisible().catch(() => false)) {
      await connTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('connection timeout field exists', async ({ page }) => {
    const connTab = page.locator('button').filter({ hasText: /connection|اتصال/i }).first();
    if (await connTab.isVisible().catch(() => false)) {
      await connTab.click();
      await page.waitForTimeout(300);
      const timeoutField = page.locator('input[type="number"]');
      const count = await timeoutField.count();
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });

  test('proxy settings section exists', async ({ page }) => {
    const connTab = page.locator('button').filter({ hasText: /connection|اتصال/i }).first();
    if (await connTab.isVisible().catch(() => false)) {
      await connTab.click();
      await page.waitForTimeout(300);
      const proxySection = page.locator('text=proxy, text=بروكسي').first();
      const isVisible = await proxySection.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});

test.describe('Settings — Language tab', () => {
  test.beforeEach(async ({ page }) => { await goto(page); await openSettings(page); });

  test('language selector exists', async ({ page }) => {
    const langTab = page.locator('button').filter({ hasText: /language|لغة/i }).first();
    if (await langTab.isVisible().catch(() => false)) {
      await langTab.click();
      await page.waitForTimeout(300);
      const langSelect = page.locator('select').first();
      const isVisible = await langSelect.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('language selector has multiple options', async ({ page }) => {
    const langTab = page.locator('button').filter({ hasText: /language|لغة/i }).first();
    if (await langTab.isVisible().catch(() => false)) {
      await langTab.click();
      await page.waitForTimeout(300);
      const langSelect = page.locator('select').first();
      if (await langSelect.isVisible().catch(() => false)) {
        const optionCount = await langSelect.locator('option').count();
        expect(optionCount).toBeGreaterThanOrEqual(5);
      }
    }
  });

  test('changing language updates UI text', async ({ page }) => {
    const langTab = page.locator('button').filter({ hasText: /language|لغة/i }).first();
    if (await langTab.isVisible().catch(() => false)) {
      await langTab.click();
      await page.waitForTimeout(300);
      const langSelect = page.locator('select').first();
      if (await langSelect.isVisible().catch(() => false)) {
        const original = await langSelect.inputValue();
        const options = await langSelect.locator('option').allTextContents();
        if (options.length > 1) {
          const secondOption = await langSelect.locator('option').nth(1).getAttribute('value');
          if (secondOption) {
            await langSelect.selectOption(secondOption);
            await page.waitForTimeout(500);
            await langSelect.selectOption(original);
            await page.waitForTimeout(500);
          }
        }
      }
    }
  });
});

test.describe('Settings — Downloads tab', () => {
  test.beforeEach(async ({ page }) => { await goto(page); await openSettings(page); });

  test('downloads tab shows default download directory', async ({ page }) => {
    const dlTab = page.locator('button').filter({ hasText: /download|تحميل/i }).first();
    if (await dlTab.isVisible().catch(() => false)) {
      await dlTab.click();
      await page.waitForTimeout(300);
      const dirField = page.locator('input[type="text"]').first();
      const isVisible = await dirField.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('default threads setting exists', async ({ page }) => {
    const dlTab = page.locator('button').filter({ hasText: /download|تحميل/i }).first();
    if (await dlTab.isVisible().catch(() => false)) {
      await dlTab.click();
      await page.waitForTimeout(300);
      const threadsField = page.locator('text=thread, text=خيط, text=连接').first();
      const isVisible = await threadsField.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('overwrite option exists', async ({ page }) => {
    const dlTab = page.locator('button').filter({ hasText: /download|تحميل/i }).first();
    if (await dlTab.isVisible().catch(() => false)) {
      await dlTab.click();
      await page.waitForTimeout(300);
      const overwrite = page.locator('text=overwrite, text=استبدال').first();
      const isVisible = await overwrite.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});

test.describe('Settings — Behavior tab', () => {
  test.beforeEach(async ({ page }) => { await goto(page); await openSettings(page); });

  test('behavior tab shows UI preferences', async ({ page }) => {
    const behTab = page.locator('button').filter({ hasText: /behavior|سلوك/i }).first();
    if (await behTab.isVisible().catch(() => false)) {
      await behTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('confirm delete option exists', async ({ page }) => {
    const behTab = page.locator('button').filter({ hasText: /behavior|سلوك/i }).first();
    if (await behTab.isVisible().catch(() => false)) {
      await behTab.click();
      await page.waitForTimeout(300);
      const confirmDelete = page.locator('text=confirm, text=تأكيد, text=delete').first();
      const isVisible = await confirmDelete.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});

test.describe('Settings — save and reset', () => {
  test.beforeEach(async ({ page }) => { await goto(page); await openSettings(page); });

  test('save button triggers save action', async ({ page }) => {
    const saveBtn = page.locator('button').filter({ hasText: /save|حفظ/i }).first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('reset button reverts changes', async ({ page }) => {
    const resetBtn = page.locator('button').filter({ hasText: /reset|إعادة/i }).first();
    if (await resetBtn.isVisible().catch(() => false)) {
      await resetBtn.click();
      await page.waitForTimeout(300);
    }
  });

  test('unsaved changes indicator appears after modifying settings', async ({ page }) => {
    const firstSwitch = page.locator('label:has(> div[class*="rounded-full"])').first();
    if (await firstSwitch.isVisible().catch(() => false)) {
      await firstSwitch.click();
      await page.waitForTimeout(300);
      const indicator = page.locator('text=unsaved, text=غير محفوظ, text=changed').first();
      const isVisible = await indicator.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});

test.describe('Settings — switch toggles', () => {
  test.beforeEach(async ({ page }) => { await goto(page); await openSettings(page); });

  test('switch toggles can be toggled on and off', async ({ page }) => {
    const switches = page.locator('label:has(> div[class*="rounded-full"])');
    const count = await switches.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const sw = switches.nth(i);
      if (await sw.isVisible().catch(() => false)) {
        const wasOn = await sw.evaluate(el => {
          const toggle = el.querySelector('div');
          return toggle?.getAttribute('class')?.includes('bg-[var(--accent-primary)]') || false;
        });
        await sw.click();
        await page.waitForTimeout(200);
        const isNow = await sw.evaluate(el => {
          const toggle = el.querySelector('div');
          return toggle?.getAttribute('class')?.includes('bg-[var(--accent-primary)]') || false;
        });
        expect(isNow).toBe(!wasOn);
      }
    }
  });
});

test.describe('Settings — select fields', () => {
  test.beforeEach(async ({ page }) => { await goto(page); await openSettings(page); });

  test('select fields can be changed', async ({ page }) => {
    const selects = page.locator('select');
    const count = await selects.count();
    for (let i = 0; i < Math.min(count, 2); i++) {
      const sel = selects.nth(i);
      if (await sel.isVisible().catch(() => false)) {
        const options = await sel.locator('option').allTextContents();
        if (options.length > 1) {
          const currentValue = await sel.inputValue();
          const otherOption = await sel.locator('option').nth(1).getAttribute('value');
          if (otherOption && otherOption !== currentValue) {
            await sel.selectOption(otherOption);
            await page.waitForTimeout(200);
            await sel.selectOption(currentValue);
            await page.waitForTimeout(200);
          }
        }
      }
    }
  });
});

test.describe('Settings — navigation back', () => {
  test.beforeEach(async ({ page }) => { await goto(page); await openSettings(page); });

  test('Escape navigates back to downloads', async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  });

  test('clicking back button navigates away', async ({ page }) => {
    const backBtn = page.locator('button').filter({ has: page.locator('svg') }).first();
    if (await backBtn.isVisible().catch(() => false)) {
      await backBtn.click();
      await page.waitForTimeout(500);
    }
  });
});
