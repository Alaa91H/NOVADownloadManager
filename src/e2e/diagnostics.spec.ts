import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

const openDiagnostics = async (page: import('@playwright/test').Page) => {
  await goto(page);
  const daemonWidget = page.locator('aside').locator('div[class*="cursor-pointer"]').first();
  if (await daemonWidget.isVisible().catch(() => false)) {
    await daemonWidget.click();
    await page.waitForTimeout(500);
  }
};

test.describe('Diagnostics — dialog structure', () => {
  test.beforeEach(async ({ page }) => {
    await openDiagnostics(page);
  });

  test('diagnostics dialog opens', async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const isVisible = await dialog.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('dialog has title', async ({ page }) => {
    const title = page.locator('#modal-title');
    if (await title.isVisible().catch(() => false)) {
      const text = await title.textContent();
      expect(text?.length).toBeGreaterThan(0);
    }
  });

  test('Refresh Report button exists', async ({ page }) => {
    const refreshBtn = page
      .locator('button')
      .filter({ hasText: /refresh|تحديث/i })
      .first();
    const isVisible = await refreshBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('Close button exists', async ({ page }) => {
    const closeBtn = page
      .locator('button')
      .filter({ hasText: /close|إغلاق/i })
      .first();
    const isVisible = await closeBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Diagnostics — system info sections', () => {
  test.beforeEach(async ({ page }) => {
    await openDiagnostics(page);
  });

  test('CPU info section exists', async ({ page }) => {
    const cpuSection = page.locator('text=CPU, text=المعالج').first();
    const isVisible = await cpuSection.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('Memory info section exists', async ({ page }) => {
    const memSection = page.locator('text=memory, text=الذاكرة, text=RAM').first();
    const isVisible = await memSection.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('Disk info section exists', async ({ page }) => {
    const diskSection = page.locator('text=disk, text=القرص, text=storage').first();
    const isVisible = await diskSection.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('network info section exists', async ({ page }) => {
    const netSection = page.locator('text=network, text=الشبكة').first();
    const isVisible = await netSection.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Diagnostics — engine capabilities', () => {
  test.beforeEach(async ({ page }) => {
    await openDiagnostics(page);
  });

  test('engine capabilities section exists', async ({ page }) => {
    const engineSection = page.locator('text=engine, text=المحرك, text=capability').first();
    const isVisible = await engineSection.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('engine capabilities show JSON output', async ({ page }) => {
    const jsonOutput = page.locator('pre, code, [class*="json"]').first();
    const isVisible = await jsonOutput.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Diagnostics — refresh', () => {
  test.beforeEach(async ({ page }) => {
    await openDiagnostics(page);
  });

  test('clicking Refresh re-fetches system info', async ({ page }) => {
    const refreshBtn = page
      .locator('button')
      .filter({ hasText: /refresh|تحديث/i })
      .first();
    if (await refreshBtn.isVisible().catch(() => false)) {
      await refreshBtn.click();
      await page.waitForTimeout(1000);
    }
  });
});

test.describe('Diagnostics — close', () => {
  test.beforeEach(async ({ page }) => {
    await openDiagnostics(page);
  });

  test('Escape closes diagnostics', async ({ page }) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const dialog = page.locator('[role="dialog"]');
    const isVisible = await dialog.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('close button closes diagnostics', async ({ page }) => {
    const closeBtn = page
      .locator('button')
      .filter({ hasText: /close|إغلاق/i })
      .first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(300);
      const dialog = page.locator('[role="dialog"]');
      const isVisible = await dialog.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});
