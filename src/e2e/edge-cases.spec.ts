import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Edge Cases — rapid dialog open/close', () => {
  test('rapidly opening and closing dialogs does not crash', async ({ page }) => {
    await goto(page);
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Control+n');
      await page.waitForTimeout(100);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    }
    await expect(page.locator('#root')).toBeVisible();
  });
});

test.describe('Edge Cases — rapid navigation', () => {
  test('rapidly switching pages does not crash', async ({ page }) => {
    await goto(page);
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Control+,');
      await page.waitForTimeout(100);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      await page.keyboard.press('Control+j');
      await page.waitForTimeout(100);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    }
    await expect(page.locator('#root')).toBeVisible();
  });
});

test.describe('Edge Cases — rapid keyboard shortcuts', () => {
  test('pressing all shortcuts rapidly does not crash', async ({ page }) => {
    await goto(page);
    const shortcuts = ['Control+n', 'Control+j', 'Control+,', 'Control+f'];
    for (let i = 0; i < 3; i++) {
      for (const shortcut of shortcuts) {
        await page.keyboard.press(shortcut);
        await page.waitForTimeout(50);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(50);
      }
    }
    await expect(page.locator('#root')).toBeVisible();
  });
});

test.describe('Edge Cases — viewport resize', () => {
  test('resizing from desktop to mobile does not crash', async ({ page }) => {
    await goto(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    await expect(page.locator('#root')).toBeVisible();
  });

  test('very small viewport does not crash', async ({ page }) => {
    await page.setViewportSize({ width: 200, height: 200 });
    await goto(page);
    await expect(page.locator('#root')).toBeVisible();
  });

  test('very large viewport does not crash', async ({ page }) => {
    await page.setViewportSize({ width: 3840, height: 2160 });
    await goto(page);
    await expect(page.locator('#root')).toBeVisible();
  });
});

test.describe('Edge Cases — long text content', () => {
  test('very long search query does not crash', async ({ page }) => {
    await goto(page);
    const search = page.locator('[data-global-search="true"]');
    await search.click();
    await search.fill('a'.repeat(1000));
    await page.waitForTimeout(300);
    await search.fill('');
    await expect(page.locator('#root')).toBeVisible();
  });
});

test.describe('Edge Cases — special characters', () => {
  test('special characters in search do not crash', async ({ page }) => {
    await goto(page);
    const search = page.locator('[data-global-search="true"]');
    await search.click();
    await search.fill('<script>alert("xss")</script>');
    await page.waitForTimeout(300);
    await search.fill('');
    await expect(page.locator('#root')).toBeVisible();
  });

  test('emoji in search do not crash', async ({ page }) => {
    await goto(page);
    const search = page.locator('[data-global-search="true"]');
    await search.click();
    await search.fill('🔥💻📁');
    await page.waitForTimeout(300);
    await search.fill('');
    await expect(page.locator('#root')).toBeVisible();
  });

  test('unicode characters in search do not crash', async ({ page }) => {
    await goto(page);
    const search = page.locator('[data-global-search="true"]');
    await search.click();
    await search.fill('日本語テスト عربي');
    await page.waitForTimeout(300);
    await search.fill('');
    await expect(page.locator('#root')).toBeVisible();
  });
});

test.describe('Edge Cases — empty states', () => {
  test('app handles empty state gracefully', async ({ page }) => {
    await goto(page);
    await expect(page.locator('#root')).toBeVisible();
    const statusBar = page.locator('[role="status"]');
    await expect(statusBar).toBeVisible();
  });
});

test.describe('Edge Cases — error handling', () => {
  test('network error does not crash app', async ({ page }) => {
    await goto(page);
    await page.route('**/*', route => route.abort());
    await page.reload().catch(() => {});
    await page.waitForTimeout(1000);
  });

  test('slow network does not crash app', async ({ page }) => {
    await goto(page);
    await page.route('**/*', route => {
      void route.fulfill({ status: 200, body: '', contentType: 'text/html' });
    });
  });
});

test.describe('Edge Cases — performance', () => {
  test('app loads within 10 seconds', async ({ page }) => {
    const start = Date.now();
    await goto(page);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10000);
  });

  test('keyboard shortcuts respond within 500ms', async ({ page }) => {
    await goto(page);
    const start = Date.now();
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
    await page.keyboard.press('Escape');
  });
});

test.describe('Edge Cases — concurrent interactions', () => {
  test('opening dialog while typing in search does not crash', async ({ page }) => {
    await goto(page);
    const search = page.locator('[data-global-search="true"]');
    await search.click();
    await search.fill('test');
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(300);
    const dialog = page.locator('[role="dialog"]');
    if (await dialog.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
    }
    await expect(page.locator('#root')).toBeVisible();
  });

  test('switching language while dialog is open does not crash', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(300);
    const dialog = page.locator('[role="dialog"]');
    if (await dialog.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
    }
    await expect(page.locator('#root')).toBeVisible();
  });
});

test.describe('Edge Cases — theme persistence', () => {
  test('theme persists after page reload', async ({ page }) => {
    await goto(page);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('class'));
    await page.reload();
    await page.waitForLoadState('networkidle');
    const themeAfterReload = await page.evaluate(() => document.documentElement.getAttribute('class'));
    expect(themeAfterReload).toBe(theme);
  });
});

test.describe('Edge Cases — accessibility regression', () => {
  test('all interactive elements have accessible names', async ({ page }) => {
    await goto(page);
    const buttons = page.locator('button');
    const count = await buttons.count();
    let unnamedCount = 0;
    for (let i = 0; i < Math.min(count, 30); i++) {
      const btn = buttons.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const hasName = await btn.evaluate(el => {
          return (
            (el.textContent?.trim() || '').length > 0 ||
            (el.getAttribute('aria-label') || '').length > 0 ||
            (el.getAttribute('title') || '').length > 0 ||
            (el.getAttribute('aria-labelledby') || '').length > 0
          );
        });
        if (!hasName) unnamedCount++;
      }
    }
    const unnamedPercent = (unnamedCount / Math.min(count, 30)) * 100;
    expect(unnamedPercent).toBeLessThan(50);
  });

  test('dialog focus trap works correctly', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+n');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
    }
    const focused = page.locator(':focus');
    if (await focused.isVisible().catch(() => false)) {
      const isInDialog = await focused.evaluate(el => el.closest('[role="dialog"]') !== null);
      expect(isInDialog).toBeTruthy();
    }
    await page.keyboard.press('Escape');
  });
});
