import { test, expect, type Page } from '@playwright/test';

const goto = async (page: Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

const propertiesDialog = (page: Page) => page.getByRole('dialog', { name: /properties|الخصائص/i });

const SEEDED_TASK = {
  id: 'task-properties-e2e',
  name: 'properties-fixture.zip',
  url: 'https://example.com/properties-fixture.zip',
  fileType: 'compressed',
  status: 'paused',
  sizeBytes: 1024,
  downloadedBytes: 0,
  speedBytesPerSec: 0,
  timeLeftSeconds: 0,
  elapsedSeconds: 0,
  dateAdded: '2024-01-01T00:00:00.000Z',
  category: 'other',
  queueId: 'main',
  connections: 1,
  resumable: true,
  savePath: '/tmp/properties-fixture.zip',
  description: '',
  segments: [],
};

const seedTask = async (page: Page) => {
  await page.evaluate(async (task) => {
    const storeUrl = '/src/store/taskStore.ts';
    const mod = (await import(storeUrl)) as {
      taskStore: { getState: () => { setTasks: (tasks: unknown[]) => void } };
    };
    mod.taskStore.getState().setTasks([task]);
  }, SEEDED_TASK);
  await expect(page.locator('tr.desktop-table-row').first()).toBeVisible();
};

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
    await seedTask(page);
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
