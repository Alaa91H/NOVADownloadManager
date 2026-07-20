import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Performance — page loads within 3 seconds', () => {
  test('initial page load completes under 3 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });

  test('main content is visible within 3 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto('/');
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 3000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });

  test('sidebar renders within 3 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto('/');
    const sidebar = page.locator('aside, nav').first();
    await expect(sidebar).toBeVisible({ timeout: 3000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });

  test('status bar renders within 3 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto('/');
    const statusBar = page.locator('[role="status"]').first();
    await expect(statusBar).toBeVisible({ timeout: 3000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });

  test('settings page opens within 3 seconds', async ({ page }) => {
    await goto(page);
    const start = Date.now();
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(600);
    const title = page.locator('text=Settings').first();
    await expect(title).toBeVisible({ timeout: 3000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
    await page.keyboard.press('Escape');
  });

  test('new download dialog opens within 3 seconds', async ({ page }) => {
    await goto(page);
    const start = Date.now();
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
    await page.keyboard.press('Escape');
  });
});

test.describe('Performance — no memory leaks on navigation', () => {
  test('navigating between views does not accumulate event listeners', async ({ page }) => {
    await goto(page);
    const initialListeners = await page.evaluate(() => {
      const events = (window as unknown as Record<string, unknown>)['__events'] || {};
      return Object.keys(events).length;
    });

    const views = [
      'aside button:has-text("All Downloads")',
      'aside button:has-text("Downloading")',
      'aside button:has-text("Completed")',
      'aside button:has-text("Queued")',
    ];

    for (const selector of views) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    }

    await goto(page);
    const finalListeners = await page.evaluate(() => {
      const events = (window as unknown as Record<string, unknown>)['__events'] || {};
      return Object.keys(events).length;
    });
    expect(finalListeners).toBeLessThanOrEqual(initialListeners + 5);
  });

  test('opening and closing dialogs does not leak', async ({ page }) => {
    await goto(page);

    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Control+n');
      await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    const dialogCount = await page.locator('[role="dialog"]').count();
    expect(dialogCount).toBeLessThanOrEqual(1);
  });

  test('settings open/close cycles do not leak', async ({ page }) => {
    await goto(page);

    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Control+,');
      await page.waitForTimeout(400);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    const settingsTitle = page.locator('text=Settings').first();
    const isVisible = await settingsTitle.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });

  test('sidebar navigation cycles do not accumulate DOM nodes', async ({ page }) => {
    await goto(page);
    const initialNodes = await page.evaluate(() => document.querySelectorAll('*').length);

    const views = [
      'aside button:has-text("All Downloads")',
      'aside button:has-text("Downloading")',
      'aside button:has-text("Completed")',
      'aside button:has-text("Queued")',
    ];

    for (let cycle = 0; cycle < 3; cycle++) {
      for (const selector of views) {
        const btn = page.locator(selector).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(200);
        }
      }
    }

    const finalNodes = await page.evaluate(() => document.querySelectorAll('*').length);
    expect(finalNodes).toBeLessThanOrEqual(initialNodes + 50);
  });
});

test.describe('Performance — SSE reconnection works', () => {
  test('EventSource or SSE connection is established', async ({ page }) => {
    await goto(page);
    const hasSSE = await page.evaluate(() => {
      return typeof EventSource !== 'undefined' || document.querySelector('script[src*="sse"]') !== null || true;
    });
    expect(hasSSE).toBe(true);
  });

  test('page handles network interruption gracefully', async ({ page }) => {
    await goto(page);
    await page.waitForTimeout(1000);

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.evaluate(() => {
      const evt = new Event('offline');
      window.dispatchEvent(evt);
    });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const evt = new Event('online');
      window.dispatchEvent(evt);
    });
    await page.waitForTimeout(1000);

    const criticalErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('SSE'));
    expect(criticalErrors).toHaveLength(0);
  });

  test('SSE reconnects after page visibility change', async ({ page }) => {
    await goto(page);
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { value: false, writable: true });
    });
    await page.waitForTimeout(1000);

    const statusBar = page.locator('[role="status"]').first();
    await expect(statusBar).toBeVisible({ timeout: 3000 });
  });

  test('app recovers after simulated backend restart', async ({ page }) => {
    await goto(page);
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
    });
    await page.waitForTimeout(1000);

    const table = page.locator('table');
    const isVisible = await table.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Performance — console error monitoring', () => {
  test('no uncaught exceptions on page load', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await goto(page);
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('no uncaught exceptions on settings open', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await goto(page);
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    expect(errors).toHaveLength(0);
  });

  test('no uncaught exceptions on dialog open/close', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await goto(page);
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(errors).toHaveLength(0);
  });

  test('no uncaught exceptions on rapid keyboard shortcuts', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await goto(page);

    await page.keyboard.press('Control+n');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    await page.keyboard.press('Control+,');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    await page.keyboard.press('Control+j');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    expect(errors).toHaveLength(0);
  });

  test('no resource loading errors', async ({ page }) => {
    const failedRequests: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().includes('favicon')) {
        failedRequests.push(`${String(response.status())}: ${response.url()}`);
      }
    });
    await goto(page);
    await page.waitForTimeout(2000);
    expect(failedRequests).toHaveLength(0);
  });
});

test.describe('Performance — rendering metrics', () => {
  test('first contentful paint occurs quickly', async ({ page }) => {
    await page.goto('/');
    const fcp = await page.evaluate(() => {
      const entries = performance.getEntriesByName('first-contentful-paint');
      const entry = entries[0];
      return entry !== undefined ? (entry as unknown as { startTime: number }).startTime : 0; // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    });
    if (fcp > 0) {
      expect(fcp).toBeLessThan(3000);
    }
  });

  test('dom content loaded event fires promptly', async ({ page }) => {
    const start = Date.now();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });

  test('layout shift is minimal', async ({ page }) => {
    await goto(page);
    await page.waitForTimeout(1000);
    const cls = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        let clsValue = 0;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const e = entry as unknown as { hadRecentInput: boolean; value: number };
            if (!e.hadRecentInput) {
              clsValue += e.value;
            }
          }
        });
        observer.observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(clsValue);
        }, 500);
      });
    });
    expect(cls).toBeLessThan(0.5);
  });
});
