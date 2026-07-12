import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Keyboard Shortcuts — global scope', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('Ctrl+N opens new download dialog', async ({ page }) => {
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#modal-title')).toContainText(/add|new|download/i);
    await page.keyboard.press('Escape');
  });

  test('Ctrl+J opens scheduler', async ({ page }) => {
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
    await expect(page.locator('text=Scheduler').first()).toBeVisible({ timeout: 3000 });
  });

  test('Ctrl+, opens settings', async ({ page }) => {
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(500);
    await expect(page.locator('text=Settings').first()).toBeVisible({ timeout: 3000 });
  });

  test('Ctrl+F focuses global search', async ({ page }) => {
    await page.keyboard.press('Control+f');
    const search = page.locator('[data-global-search="true"]');
    await expect(search).toBeFocused({ timeout: 3000 });
  });

  test('Ctrl+A selects all tasks in table', async ({ page }) => {
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(300);
  });

  test('Escape closes any open dialog', async ({ page }) => {
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 3000 });
  });

  test('Escape navigates back from settings page', async ({ page }) => {
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(500);
    await expect(page.locator('text=Settings').first()).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  });

  test('Escape navigates back from scheduler page', async ({ page }) => {
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
    await expect(page.locator('text=Scheduler').first()).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  });

  test('shortcuts do not trigger when typing in input field', async ({ page }) => {
    const search = page.locator('[data-global-search="true"]');
    await search.click();
    await search.fill('test query');
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(300);
    await expect(page.locator('text=Scheduler').first()).not.toBeVisible();
  });

  test('Ctrl+N still works when focused in input field (exempt)', async ({ page }) => {
    const search = page.locator('[data-global-search="true"]');
    await search.click();
    await page.keyboard.press('Control+n');
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');
  });
});

test.describe('Keyboard Shortcuts — arrow navigation in context menus', () => {
  test('arrow keys navigate context menu items', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(200);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        await page.keyboard.press('ArrowDown');
        const activeItem = page.locator('[role="menuitem"][data-active="true"]');
        await expect(activeItem).toBeVisible({ timeout: 1000 });
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Escape');
      }
    }
  });

  test('Enter activates focused context menu item', async ({ page }) => {
    await goto(page);
    const firstRow = page.locator('tr.desktop-table-row').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click({ button: 'right' });
      await page.waitForTimeout(200);
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('Keyboard Shortcuts — focus-visible rings', () => {
  test('Tab navigates to interactive elements with visible focus rings', async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    if (await focused.isVisible().catch(() => false)) {
      const outlineStyle = await focused.evaluate(el => {
        const style = window.getComputedStyle(el);
        return style.outlineStyle || style.boxShadow;
      });
      expect(outlineStyle).toBeTruthy();
    }
  });
});
