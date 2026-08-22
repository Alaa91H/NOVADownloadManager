import { test, expect, type Page } from '@playwright/test';

const goto = async (page: Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

const propertiesDialog = (page: Page) => page.getByRole('dialog', { name: /properties|الخصائص/i });

const openProperties = async (page: Page) => {
  const firstRow = page.locator('tr.desktop-table-row').first();
  await expect(firstRow).toBeVisible();
  await firstRow.click({ button: 'right' });
  const properties = page.getByRole('menuitem', { name: /properties|الخصائص/i });
  await expect(properties).toBeVisible();
  await properties.click();
  await expect(propertiesDialog(page)).toBeVisible();
};

test.describe('Task Properties', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('opens from a task context menu', async ({ page }) => {
    await openProperties(page);
    await expect(propertiesDialog(page).locator('h3')).toContainText(/properties|الخصائص/i);
  });

  test('shows task metadata fields', async ({ page }) => {
    await openProperties(page);
    const dialog = propertiesDialog(page);
    await expect(dialog).toContainText(/url|رابط/i);
    await expect(dialog).toContainText(/status|الحالة/i);
    await expect(dialog).toContainText(/size|الحجم/i);
  });

  test('Escape closes the specific properties dialog', async ({ page }) => {
    await openProperties(page);
    await page.keyboard.press('Escape');
    await expect(propertiesDialog(page)).not.toBeVisible();
  });

  test('the close control closes the specific properties dialog', async ({ page }) => {
    await openProperties(page);
    const dialog = propertiesDialog(page);
    const close = dialog.locator('button[title*="close" i], button[title*="إغلاق" i]').first();
    await expect(close).toBeVisible();
    await close.click();
    await expect(dialog).not.toBeVisible();
  });
});
