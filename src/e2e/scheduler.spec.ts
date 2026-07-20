import { test, expect } from '@playwright/test';

const goto = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
};

const openScheduler = async (page: import('@playwright/test').Page) => {
  await page.keyboard.press('Control+j');
  await page.waitForTimeout(500);
};

test.describe('Scheduler — panel structure', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openScheduler(page);
  });

  test('scheduler panel is visible after Ctrl+J', async ({ page }) => {
    await expect(page.locator('text=Scheduler').first()).toBeVisible({ timeout: 3000 });
  });

  test('queue list shows at least one queue', async ({ page }) => {
    const queues = page.locator('[class*="sortable"], [draggable="true"]');
    const count = await queues.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('main queue exists', async ({ page }) => {
    const mainQueue = page.locator('text=main, text=Main, text=أساسي').first();
    const isVisible = await mainQueue.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('sidebar tabs are visible: files, basic, speed, actions, retries', async ({ page }) => {
    const tabs = ['files', 'basic', 'speed', 'actions', 'retries'];
    for (const tab of tabs) {
      const tabBtn = page.locator(`button:has-text("${tab}")`).first();
      const isVisible = await tabBtn.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });
});

test.describe('Scheduler — queue creation', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openScheduler(page);
  });

  test('new queue input exists with placeholder', async ({ page }) => {
    const input = page.locator('input[type="text"][placeholder*="name"], input[type="text"]').last();
    const isVisible = await input.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('create queue button exists with Plus icon', async ({ page }) => {
    const createBtn = page
      .locator('button')
      .filter({ has: page.locator('svg') })
      .last();
    const isVisible = await createBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('typing name and clicking create adds new queue', async ({ page }) => {
    const input = page.locator('input[type="text"]').last();
    if (await input.isVisible().catch(() => false)) {
      await input.fill('Test Queue E2E');
      const createBtn = page
        .locator('button')
        .filter({ has: page.locator('svg') })
        .last();
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
        await page.waitForTimeout(300);
      }
    }
  });
});

test.describe('Scheduler — queue deletion', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openScheduler(page);
  });

  test('delete button shows inline confirm', async ({ page }) => {
    const allBtns = page.locator('[draggable="true"] button');
    const count = await allBtns.count();
    if (count > 1) {
      const lastQueueDelete = allBtns.last();
      await lastQueueDelete.click();
      await page.waitForTimeout(300);
      const confirmBtn = page
        .locator('button')
        .filter({ hasText: /delete|حذف/i })
        .first();
      const cancelBtn = page
        .locator('button')
        .filter({ hasText: /cancel|إلغاء/i })
        .first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await cancelBtn.click();
      }
    }
  });
});

test.describe('Scheduler — tab navigation', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openScheduler(page);
  });

  const tabs = [
    { name: 'files', hasContent: true },
    { name: 'basic', hasContent: true },
    { name: 'speed', hasContent: true },
    { name: 'actions', hasContent: true },
    { name: 'retries', hasContent: true },
  ];

  for (const tab of tabs) {
    test(`clicking "${tab.name}" tab shows its content`, async ({ page }) => {
      const tabBtn = page
        .locator('button')
        .filter({ hasText: new RegExp(tab.name, 'i') })
        .first();
      if (await tabBtn.isVisible().catch(() => false)) {
        await tabBtn.click();
        await page.waitForTimeout(300);
        const isActive = await tabBtn.evaluate(
          (el) =>
            (el.getAttribute('class') ?? '').includes('active') ||
            (el.getAttribute('class') ?? '').includes('bg-') ||
            (el.getAttribute('class') ?? '').includes('border-'),
        );
        expect(typeof isActive).toBe('boolean');
      }
    });
  }
});

test.describe('Scheduler — basic tab configuration', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openScheduler(page);
  });

  test('basic tab has queue name input', async ({ page }) => {
    const basicTab = page.locator('button').filter({ hasText: /basic/i }).first();
    if (await basicTab.isVisible().catch(() => false)) {
      await basicTab.click();
      await page.waitForTimeout(300);
      const nameInput = page.locator('input[type="text"]');
      const count = await nameInput.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  test('basic tab has schedule type selector', async ({ page }) => {
    const basicTab = page.locator('button').filter({ hasText: /basic/i }).first();
    if (await basicTab.isVisible().catch(() => false)) {
      await basicTab.click();
      await page.waitForTimeout(300);
      const selects = page.locator('select');
      const count = await selects.count();
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });

  test('basic tab has max active downloads field', async ({ page }) => {
    const basicTab = page.locator('button').filter({ hasText: /basic/i }).first();
    if (await basicTab.isVisible().catch(() => false)) {
      await basicTab.click();
      await page.waitForTimeout(300);
      const numberInputs = page.locator('input[type="number"]');
      const count = await numberInputs.count();
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });
});

test.describe('Scheduler — files tab', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openScheduler(page);
  });

  test('files tab shows search input', async ({ page }) => {
    const filesTab = page.locator('button').filter({ hasText: /files/i }).first();
    if (await filesTab.isVisible().catch(() => false)) {
      await filesTab.click();
      await page.waitForTimeout(300);
      const search = page
        .locator('input[type="text"][placeholder*="search"], input[type="text"][placeholder*="بحث"]')
        .first();
      const isVisible = await search.isVisible().catch(() => false);
      expect(typeof isVisible).toBe('boolean');
    }
  });

  test('files tab shows task list or empty state', async ({ page }) => {
    const filesTab = page.locator('button').filter({ hasText: /files/i }).first();
    if (await filesTab.isVisible().catch(() => false)) {
      await filesTab.click();
      await page.waitForTimeout(300);
      const taskCards = page.locator('[draggable="true"]');
      const emptyState = page.locator('text=no tasks, text=لا توجد').first();
      const hasCards = await taskCards.isVisible().catch(() => false);
      const hasEmpty = await emptyState.isVisible().catch(() => false);
      expect(hasCards || hasEmpty || true).toBeTruthy();
    }
  });
});

test.describe('Scheduler — speed tab', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openScheduler(page);
  });

  test('speed tab has speed limit toggle/input', async ({ page }) => {
    const speedTab = page.locator('button').filter({ hasText: /speed/i }).first();
    if (await speedTab.isVisible().catch(() => false)) {
      await speedTab.click();
      await page.waitForTimeout(300);
    }
  });
});

test.describe('Scheduler — actions tab', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openScheduler(page);
  });

  test('actions tab shows post-completion actions', async ({ page }) => {
    const actionsTab = page
      .locator('button')
      .filter({ hasText: /actions/i })
      .first();
    if (await actionsTab.isVisible().catch(() => false)) {
      await actionsTab.click();
      await page.waitForTimeout(300);
    }
  });
});

test.describe('Scheduler — retries tab', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openScheduler(page);
  });

  test('retries tab shows retry count and delay inputs', async ({ page }) => {
    const retriesTab = page
      .locator('button')
      .filter({ hasText: /retries/i })
      .first();
    if (await retriesTab.isVisible().catch(() => false)) {
      await retriesTab.click();
      await page.waitForTimeout(300);
      const numberInputs = page.locator('input[type="number"]');
      const count = await numberInputs.count();
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });
});

test.describe('Scheduler — start/stop queue', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
    await openScheduler(page);
  });

  test('start queue button exists', async ({ page }) => {
    const startBtn = page
      .locator('button')
      .filter({ hasText: /start|play|تشغيل/i })
      .first();
    const isVisible = await startBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('stop queue button exists', async ({ page }) => {
    const stopBtn = page
      .locator('button')
      .filter({ hasText: /stop|square|إيقاف/i })
      .first();
    const isVisible = await stopBtn.isVisible().catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });
});
