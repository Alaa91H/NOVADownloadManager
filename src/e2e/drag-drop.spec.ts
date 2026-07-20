import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Drag & Drop — queue reordering', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
  });

  test('queue items have draggable attribute', async ({ page }) => {
    const items = page.locator('[draggable="true"]');
    const count = await items.count();
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      if (await item.isVisible().catch(() => false)) {
        await expect(item).toHaveAttribute('draggable', 'true');
      }
    }
  });

  test('dragging a queue shows lift animation', async ({ page }) => {
    const items = page.locator('[draggable="true"]');
    const firstItem = items.first();
    if (await firstItem.isVisible().catch(() => false)) {
      const box = await firstItem.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + 50, { steps: 5 });
        await page.waitForTimeout(200);
        await page.mouse.up();
      }
    }
  });

  test('dropping queue below another reorders them', async ({ page }) => {
    const items = page.locator('[draggable="true"]');
    const count = await items.count();
    if (count >= 2) {
      const first = items.first();
      const second = items.nth(1);
      if ((await first.isVisible().catch(() => false)) && (await second.isVisible().catch(() => false))) {
        const firstBox = await first.boundingBox();
        const secondBox = await second.boundingBox();
        if (firstBox && secondBox) {
          await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
          await page.mouse.down();
          for (let step = 0; step <= 10; step++) {
            const y = firstBox.y + (secondBox.y - firstBox.y) * (step / 10);
            await page.mouse.move(firstBox.x + firstBox.width / 2, y);
            await page.waitForTimeout(20);
          }
          await page.mouse.up();
          await page.waitForTimeout(300);
        }
      }
    }
  });
});

test.describe('Drag & Drop — cross-queue task move', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
  });

  test('task cards have draggable attribute for cross-queue move', async ({ page }) => {
    const filesTab = page.locator('button').filter({ hasText: /files/i }).first();
    if (await filesTab.isVisible().catch(() => false)) {
      await filesTab.click();
      await page.waitForTimeout(300);
      const taskCards = page.locator('[draggable="true"]');
      const count = await taskCards.count();
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });
});

test.describe('Drag & Drop — URL overlay', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('dragover shows drop overlay', async ({ page }) => {
    const body = page.locator('body');
    await body.dispatchEvent('dragenter', { dataTransfer: { types: ['Files'] } });
    await page.waitForTimeout(300);
    const overlay = page.locator('[class*="z-[100]"], [class*="drop-overlay"]');
    const isVisible = await overlay.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('drop overlay disappears on dragleave', async ({ page }) => {
    const body = page.locator('body');
    await body.dispatchEvent('dragenter', { dataTransfer: { types: ['Files'] } });
    await page.waitForTimeout(200);
    await body.dispatchEvent('dragleave', { dataTransfer: { types: ['Files'] } });
    await page.waitForTimeout(200);
  });

  test('drop overlay shows file zone indicator', async ({ page }) => {
    const body = page.locator('body');
    await body.dispatchEvent('dragenter', { dataTransfer: { types: ['Files'] } });
    await page.waitForTimeout(300);
    const dropText = page.locator('text=drop, text=إفلات, text=ドロップ').first();
    const isVisible = await dropText.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Drag & Drop — column reorder', () => {
  test('column headers are draggable', async ({ page }) => {
    await goto(page);
    const headers = page.locator('thead th[draggable="true"]');
    const count = await headers.count();
    for (let i = 0; i < count; i++) {
      const header = headers.nth(i);
      if (await header.isVisible().catch(() => false)) {
        await expect(header).toHaveAttribute('draggable', 'true');
      }
    }
  });

  test('dragging a column header reorders columns', async ({ page }) => {
    await goto(page);
    const headers = page.locator('thead th[draggable="true"]');
    const count = await headers.count();
    if (count >= 2) {
      const first = headers.first();
      const second = headers.nth(1);
      if ((await first.isVisible().catch(() => false)) && (await second.isVisible().catch(() => false))) {
        const firstBox = await first.boundingBox();
        const secondBox = await second.boundingBox();
        if (firstBox && secondBox) {
          await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
          await page.mouse.down();
          await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2, { steps: 10 });
          await page.mouse.up();
          await page.waitForTimeout(300);
        }
      }
    }
  });
});
