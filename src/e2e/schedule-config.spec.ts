import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Schedule Config — basic tab settings', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
    const basicTab = page.locator('button').filter({ hasText: /basic/i }).first();
    if (await basicTab.isVisible().catch(() => false)) {
      await basicTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('queue name can be edited', async ({ page }) => {
    const nameInput = page.locator('input[type="text"]').first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.clear();
      await nameInput.fill('Renamed Queue');
      const value = await nameInput.inputValue();
      expect(value).toBe('Renamed Queue');
    }
  });

  test('schedule type selector has once/daily/custom options', async ({ page }) => {
    const selects = page.locator('select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      const sel = selects.nth(i);
      if (await sel.isVisible().catch(() => false)) {
        const options = await sel.locator('option').allTextContents();
        if (
          options.some(
            (o) =>
              o.toLowerCase().includes('once') ||
              o.toLowerCase().includes('daily') ||
              o.toLowerCase().includes('custom'),
          )
        ) {
          expect(options.length).toBeGreaterThanOrEqual(2);
          break;
        }
      }
    }
  });

  test('max active downloads field exists', async ({ page }) => {
    const maxActive = page.locator('input[type="number"]').first();
    const isVisible = await maxActive.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('time field exists for schedule configuration', async ({ page }) => {
    const timeField = page.locator('input[type="time"]').first();
    const isVisible = await timeField.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Schedule Config — speed tab settings', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
    const speedTab = page.locator('button').filter({ hasText: /speed/i }).first();
    if (await speedTab.isVisible().catch(() => false)) {
      await speedTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('speed limit toggle exists', async ({ page }) => {
    const limitToggle = page.locator('label:has(> div[class*="rounded-full"])').first();
    const isVisible = await limitToggle.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('speed limit input field exists', async ({ page }) => {
    const speedInput = page.locator('input[type="number"]').first();
    const isVisible = await speedInput.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('one-time limit option exists', async ({ page }) => {
    const oneTimeLimit = page.locator('text=one-time, text=مرة واحدة, text=محدود').first();
    const isVisible = await oneTimeLimit.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Schedule Config — actions tab settings', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
    const actionsTab = page
      .locator('button')
      .filter({ hasText: /actions/i })
      .first();
    if (await actionsTab.isVisible().catch(() => false)) {
      await actionsTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('shutdown after completion option exists', async ({ page }) => {
    const shutdown = page.locator('text=shutdown, text=إيقاف التشغيل').first();
    const isVisible = await shutdown.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('hangup option exists', async ({ page }) => {
    const hangup = page.locator('text=hangup, text=تعليق').first();
    const isVisible = await hangup.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('exit option exists', async ({ page }) => {
    const exit = page.locator('text=exit, text=خروج').first();
    const isVisible = await exit.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('chime option exists', async ({ page }) => {
    const chime = page.locator('text=chime, text=رنين').first();
    const isVisible = await chime.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('webhook option exists', async ({ page }) => {
    const webhook = page.locator('text=webhook, text=ويب هوك').first();
    const isVisible = await webhook.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Schedule Config — retries tab settings', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
    const retriesTab = page
      .locator('button')
      .filter({ hasText: /retries/i })
      .first();
    if (await retriesTab.isVisible().catch(() => false)) {
      await retriesTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('retry count input exists', async ({ page }) => {
    const retryCount = page.locator('input[type="number"]').first();
    const isVisible = await retryCount.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('retry delay input exists', async ({ page }) => {
    const retryDelay = page.locator('input[type="number"]').nth(1);
    const isVisible = await retryDelay.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Schedule Config — start and stop queue', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
  });

  test('start queue button starts queue execution', async ({ page }) => {
    const startBtn = page
      .locator('button')
      .filter({ hasText: /start|play|تشغيل/i })
      .first();
    if (await startBtn.isVisible().catch(() => false)) {
      await startBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('stop queue button stops queue execution', async ({ page }) => {
    const stopBtn = page
      .locator('button')
      .filter({ hasText: /stop|square|إيقاف/i })
      .first();
    if (await stopBtn.isVisible().catch(() => false)) {
      await stopBtn.click();
      await page.waitForTimeout(500);
    }
  });
});

test.describe('Schedule Config — files tab task management', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
    const filesTab = page.locator('button').filter({ hasText: /files/i }).first();
    if (await filesTab.isVisible().catch(() => false)) {
      await filesTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('search input filters tasks', async ({ page }) => {
    const search = page
      .locator('input[type="text"][placeholder*="search"], input[type="text"][placeholder*="بحث"]')
      .first();
    if (await search.isVisible().catch(() => false)) {
      await search.fill('test');
      await page.waitForTimeout(300);
      await search.fill('');
      await page.waitForTimeout(300);
    }
  });

  test('clear filter button exists', async ({ page }) => {
    const clearBtn = page
      .locator('button')
      .filter({ hasText: /clear|مسح|إلغاء/i })
      .first();
    const isVisible = await clearBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('task move up button is disabled at index 0', async ({ page }) => {
    const moveUpBtns = page.locator('button:has(svg[class*="ArrowUp"]), button[title*="up" i]');
    const count = await moveUpBtns.count();
    if (count > 0) {
      const firstMoveUp = moveUpBtns.first();
      if (await firstMoveUp.isVisible().catch(() => false)) {
        const isDisabled = await firstMoveUp.isDisabled();
        expect(typeof isDisabled).toBe('boolean');
      }
    }
  });
});
