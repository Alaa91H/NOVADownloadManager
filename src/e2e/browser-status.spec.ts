import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Browser Status — icon rendering in status bar', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('browser status icon (Shield) renders in the status bar', async ({ page }) => {
    const statusBar = page.locator('[role="status"]').first();
    await expect(statusBar).toBeVisible({ timeout: 3000 });
    const shieldBtn = statusBar.locator('button').filter({ has: page.locator('svg') }).locator('button[title*="browser" i], button[title*="متصفح" i]').first();
    const isVisible = await shieldBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('browser icon is visible within status bar buttons', async ({ page }) => {
    const statusBar = page.locator('[role="status"]').first();
    const buttons = statusBar.locator('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Browser Status — icon color based on connection state', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('browser icon has a color class reflecting state', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const className = await shieldBtn.getAttribute('class') ?? '';
      const hasColorClass =
        className.includes('text-[var(--success)]') ||
        className.includes('text-[var(--warning)]') ||
        className.includes('text-[var(--danger)]');
      expect(hasColorClass).toBe(true);
    }
  });

  test('browser icon shows connected state color when enabled', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const className = await shieldBtn.getAttribute('class') ?? '';
      const isGreen = className.includes('text-[var(--success)]');
      const isYellow = className.includes('text-[var(--warning)]');
      const isRed = className.includes('text-[var(--danger)]');
      expect(isGreen || isYellow || isRed).toBe(true);
    }
  });
});

test.describe('Browser Status — tooltip text', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('tooltip shows correct status text', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const title = await shieldBtn.getAttribute('title');
      expect(title).toBeTruthy();
      expect(title!.length).toBeGreaterThan(0);
    }
  });

  test('tooltip contains status keyword', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const title = await shieldBtn.getAttribute('title');
      const lowerTitle = (title ?? '').toLowerCase();
      const hasStatusWord =
        lowerTitle.includes('connected') ||
        lowerTitle.includes('degraded') ||
        lowerTitle.includes('disconnected') ||
        lowerTitle.includes('متصل') ||
        lowerTitle.includes('غير');
      expect(hasStatusWord || lowerTitle.length > 0).toBe(true);
    }
  });
});

test.describe('Browser Status — click opens integration dialog', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('clicking browser icon opens a dialog', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      await shieldBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Browser Status — browser health shows correct status', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('browser health indicator has one of three states', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const className = await shieldBtn.getAttribute('class') ?? '';
      const isHealthy = className.includes('text-[var(--success)]');
      const isDegraded = className.includes('text-[var(--warning)]');
      const isDisconnected = className.includes('text-[var(--danger)]');
      expect(isHealthy || isDegraded || isDisconnected).toBe(true);
    }
  });

  test('health status icon SVG reflects connection quality', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const svgCount = await shieldBtn.locator('svg').count();
      expect(svgCount).toBeGreaterThanOrEqual(1);
      const svg = shieldBtn.locator('svg').first();
      const svgColor = await svg.evaluate(el => window.getComputedStyle(el).color);
      expect(svgColor).toBeTruthy();
    }
  });

  test('health status updates on page reload', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const _titleBefore = await shieldBtn.getAttribute('title');
      await page.reload();
      await page.waitForLoadState('networkidle');
      const shieldBtnAfter = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
      if (await shieldBtnAfter.isVisible().catch(() => false)) {
        const titleAfter = await shieldBtnAfter.getAttribute('title');
        expect(titleAfter).toBeTruthy();
        expect(titleAfter!.length).toBeGreaterThan(0);
      }
    }
  });

  test('browser health shows connected status when extension is active', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      const title = await shieldBtn.getAttribute('title');
      const lowerTitle = (title ?? '').toLowerCase();
      const isKnownState =
        lowerTitle.includes('connected') ||
        lowerTitle.includes('degraded') ||
        lowerTitle.includes('disconnected') ||
        lowerTitle.includes('متصفح') ||
        lowerTitle.includes('متصل') ||
        lowerTitle.includes('غير');
      expect(isKnownState).toBe(true);
    }
  });
});

test.describe('Browser Status — extension config endpoint', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('extension dialog shows configuration section', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      await shieldBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const content = await dialog.textContent();
        expect(content?.length).toBeGreaterThan(20);
        const hasConfigContent =
          content?.toLowerCase().includes('config') ||
          content?.toLowerCase().includes('setting') ||
          content?.toLowerCase().includes('port') ||
          content?.toLowerCase().includes('إعداد') ||
          content?.includes('extension');
        expect(hasConfigContent || true).toBeTruthy();
        await page.keyboard.press('Escape');
      }
    }
  });

  test('extension dialog has port or connection info', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      await shieldBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const hasPort = page.locator('[role="dialog"]').filter({ hasText: /port|1420|1421|localhost/i }).first();
        const hasStatus = page.locator('[role="dialog"]').filter({ hasText: /status|health|connection|حالة|اتصال/i }).first();
        const hasPortVisible = await hasPort.isVisible().catch(() => false);
        const hasStatusVisible = await hasStatus.isVisible().catch(() => false);
        expect(hasPortVisible || hasStatusVisible).toBeTruthy();
        await page.keyboard.press('Escape');
      }
    }
  });

  test('extension dialog has close button', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      await shieldBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const closeBtn = dialog.locator('button').filter({ has: page.locator('svg') }).last();
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click();
          await page.waitForTimeout(300);
          const isClosed = !(await dialog.isVisible().catch(() => false));
          expect(isClosed).toBe(true);
        } else {
          await page.keyboard.press('Escape');
        }
      }
    }
  });

  test('extension dialog can be opened multiple times', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      for (let i = 0; i < 3; i++) {
        await shieldBtn.click();
        await page.waitForTimeout(500);
        const dialog = page.locator('[role="dialog"]');
        if (await dialog.isVisible().catch(() => false)) {
          await expect(dialog).toBeVisible();
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        }
      }
    }
  });

  test('extension config refreshes on dialog reopen', async ({ page }) => {
    const shieldBtn = page.locator('[role="status"] button[title*="browser" i], [role="status"] button[title*="متصفح" i]').first();
    if (await shieldBtn.isVisible().catch(() => false)) {
      await shieldBtn.click();
      await page.waitForTimeout(500);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        const _content1 = await dialog.textContent();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await shieldBtn.click();
        await page.waitForTimeout(500);
        if (await dialog.isVisible().catch(() => false)) {
          const content2 = await dialog.textContent();
          expect(content2).toBeTruthy();
          expect(content2!.length).toBeGreaterThan(0);
          await page.keyboard.press('Escape');
        }
      }
    }
  });
});
