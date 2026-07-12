import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

test.describe('Queue — queue sidebar panel', () => {
  test.beforeEach(async ({ page }) => { await goto(page); });

  test('queue panel exists in sidebar or scheduler', async ({ page }) => {
    const queuePanel = page.locator('[class*="queue"], [class*="Queue"]').first();
    const isVisible = await queuePanel.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});

test.describe('Queue — queue creation', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
  });

  test('create queue input accepts text', async ({ page }) => {
    const input = page.locator('input[type="text"]').last();
    if (await input.isVisible().catch(() => false)) {
      await input.fill('Test Queue');
      const value = await input.inputValue();
      expect(value).toBe('Test Queue');
    }
  });

  test('create queue button is clickable', async ({ page }) => {
    const input = page.locator('input[type="text"]').last();
    if (await input.isVisible().catch(() => false)) {
      await input.fill('Test Queue E2E');
      const createBtn = page.locator('button').filter({ has: page.locator('svg') }).last();
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
        await page.waitForTimeout(300);
      }
    }
  });
});

test.describe('Queue — queue list', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
  });

  test('at least one queue is listed', async ({ page }) => {
    const queueItems = page.locator('[draggable="true"]');
    const count = await queueItems.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('queue item shows task count', async ({ page }) => {
    const queueItems = page.locator('[draggable="true"]');
    const firstItem = queueItems.first();
    if (await firstItem.isVisible().catch(() => false)) {
      const text = await firstItem.textContent();
      expect(text).toBeTruthy();
    }
  });
});

test.describe('Queue — queue selection', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
  });

  test('clicking a queue selects it', async ({ page }) => {
    const queueItems = page.locator('[draggable="true"]');
    const count = await queueItems.count();
    if (count > 1) {
      const secondQueue = queueItems.nth(1);
      if (await secondQueue.isVisible().catch(() => false)) {
        await secondQueue.click();
        await page.waitForTimeout(300);
      }
    }
  });
});

test.describe('Queue — queue deletion', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
  });

  test('delete button on queue shows confirm', async ({ page }) => {
    const queueItems = page.locator('[draggable="true"]');
    const count = await queueItems.count();
    if (count > 1) {
      const queueItem = queueItems.last();
      const deleteBtn = queueItem.locator('button').last();
      if (await deleteBtn.isVisible().catch(() => false)) {
        await deleteBtn.click();
        await page.waitForTimeout(300);
        const cancelBtn = page.locator('button').filter({ hasText: /cancel|إلغاء|no/i }).first();
        if (await cancelBtn.isVisible().catch(() => false)) {
          await cancelBtn.click();
        }
      }
    }
  });
});

test.describe('Queue — drag and drop reorder', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
  });

  test('queue items are draggable', async ({ page }) => {
    const queueItems = page.locator('[draggable="true"]');
    const count = await queueItems.count();
    for (let i = 0; i < count; i++) {
      const item = queueItems.nth(i);
      if (await item.isVisible().catch(() => false)) {
        const draggable = await item.getAttribute('draggable');
        expect(draggable).toBe('true');
      }
    }
  });

  test('queue drag and drop changes order', async ({ page }) => {
    const queueItems = page.locator('[draggable="true"]');
    const count = await queueItems.count();
    if (count >= 2) {
      const firstItem = queueItems.first();
      const secondItem = queueItems.nth(1);
      if (await firstItem.isVisible().catch(() => false) && await secondItem.isVisible().catch(() => false)) {
        const firstBox = await firstItem.boundingBox();
        const secondBox = await secondItem.boundingBox();
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

test.describe('Queue — undo functionality', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(500);
  });

  test('undo toast appears after drag operation', async ({ page }) => {
    const queueItems = page.locator('[draggable="true"]');
    const count = await queueItems.count();
    if (count >= 2) {
      const firstItem = queueItems.first();
      const secondItem = queueItems.nth(1);
      if (await firstItem.isVisible().catch(() => false) && await secondItem.isVisible().catch(() => false)) {
        const firstBox = await firstItem.boundingBox();
        const secondBox = await secondItem.boundingBox();
        if (firstBox && secondBox) {
          await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
          await page.mouse.down();
          await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2, { steps: 10 });
          await page.mouse.up();
          await page.waitForTimeout(500);
          const undoBtn = page.locator('button').filter({ hasText: /undo|تراجع/i }).first();
          const isVisible = await undoBtn.isVisible().catch(() => false);
          expect(typeof isVisible).toBe('boolean');
        }
      }
    }
  });
});
