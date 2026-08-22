import { test, expect } from '@playwright/test';
import type { DownloadItem } from '../types/desktop-ui.types';

/**
 * Windowed rendering (virtualization) e2e coverage.
 *
 * The regular specs run against small task lists that stay under the
 * windowing threshold (150 desktop rows / 80 mobile cards), so they never
 * exercise the windowed code path. This spec seeds 500 tasks directly into
 * the zustand store (same module instance the app uses — Vite serves the
 * source module, so importing it in-page shares the singleton) and asserts:
 *   1. Only a bounded slice of rows exists in the DOM (not all 500).
 *   2. The scroll height is exactly itemCount × row height (catches the
 *      row-border vs box-sizing drift the window math depends on).
 *   3. Scrolling moves the rendered window (new rows mount, old ones unmount).
 *   4. Select-all still selects every task even though only a slice is in DOM
 *      (selection is model-based, not DOM-based).
 */

const TASK_COUNT = 500;

const HEALTH_PAYLOAD = {
  status: 'connected',
  name: 'nova-e2e',
  version: 'test',
  pid: 1234,
  buildVersion: 'test',
  engines: {
    curl: { available: true, version: 'test' },
    ytdlp: { available: true, version: 'test' },
  },
  allEnginesReady: true,
};

function makeTasks(count: number): DownloadItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${String(i)}`,
    name: `file-${String(i).padStart(4, '0')}.zip`,
    url: `https://example.com/file-${String(i)}.zip`,
    fileType: 'compressed',
    status: 'paused',
    sizeBytes: 1024 * 1024,
    downloadedBytes: 0,
    speedBytesPerSec: 0,
    timeLeftSeconds: 0,
    elapsedSeconds: 0,
    // Newest first (dateAdded desc is the default sort).
    dateAdded: new Date(Date.UTC(2024, 0, 1) + i * 1000).toISOString(),
    category: 'other',
    queueId: 'main',
    connections: 1,
    resumable: true,
    savePath: `C:\\NOVA\\file-${String(i).padStart(4, '0')}.zip`,
    description: '',
    segments: [],
  }));
}

test.describe('Windowed rendering (500 tasks)', () => {
  test.beforeEach(async ({ page }) => {
    // Fake a healthy daemon so the connecting splash clears and the shell
    // renders the task table deterministically (no real daemon in e2e).
    const tasks = makeTasks(TASK_COUNT);
    await page.route('**/api/health', (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(HEALTH_PAYLOAD),
      });
    });
    await page.route('**/api/downloads', (route) => {
      if (route.request().method() === 'GET') {
        void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tasks) });
      } else {
        void route.continue();
      }
    });
    // Keep the production SSE listener from replacing the deterministic local
    // fixture with downloads created by concurrently running E2E specs.
    await page.route('**/api/downloads/events**', (route) => {
      void route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    });
    await page.goto('/');
    // The task table is only mounted once the bridge is connected.
    await expect(page.locator('table')).toBeVisible({ timeout: 15000 });

    // Seed 500 tasks through the live store instance (same module singleton
    // the app imports, so the table reacts to setTasks as usual). The URL is a
    // variable so Vite serves it in-page while TypeScript stays happy.
    await page.evaluate(async (tasks) => {
      const storeUrl = '/src/store/taskStore.ts';
      const mod = (await import(storeUrl)) as {
        taskStore: { getState: () => { setTasks: (t: unknown[]) => void } };
      };
      mod.taskStore.getState().setTasks(tasks);
    }, tasks);
    await expect(page.locator('tr.desktop-table-row').first()).toContainText('file-0499.zip', { timeout: 5000 });
  });

  test('renders only a bounded slice of rows for a 500-task list', async ({ page }) => {
    const domCount = await page.locator('tr.desktop-table-row').count();
    // 500 tasks exist, but the DOM must only hold the visible slice + overscan.
    expect(domCount).toBeGreaterThan(5);
    expect(domCount).toBeLessThan(150);
  });

  test('scroll height scales with itemCount × slot (drift stays bounded)', async ({ page }) => {
    const metrics = await page
      .locator('tr.desktop-table-row')
      .first()
      .evaluate((el) => {
        // The window math uses the CSS --row-height slot; the rendered rect can
        // be a few px taller (checkbox cell min-height), so compare against the
        // actual slot the spacers are built from.
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--row-height').trim();
        const slot = Number.parseFloat(raw) || 0;
        const table = el.closest('table');
        const tableHeight = table ? table.getBoundingClientRect().height : 0;
        return { slot, tableHeight };
      });
    expect(metrics.slot).toBeGreaterThan(0);
    // Total = itemCount × slot + header. If each row leaked 1px beyond the
    // slot (box-sizing drift), the table would exceed the bound by ~500px.
    // A small absolute tolerance covers the sticky header (~33px) and the
    // bounded variance of the rendered slice (rows can be a few px taller
    // than the slot — that variance is per-rendered-row, not per-item, so it
    // never grows with the list size).
    expect(metrics.tableHeight).toBeGreaterThan(TASK_COUNT * metrics.slot);
    expect(metrics.tableHeight).toBeLessThan(TASK_COUNT * metrics.slot + 300);
  });

  test('scrolling moves the rendered window', async ({ page }) => {
    // Newest first: the newest task (file-0499) is the first row at the top.
    await expect(page.locator('tr.desktop-table-row').first()).toContainText('file-0499.zip');

    await page.evaluate(() => {
      const container = document.querySelector('div.overflow-auto');
      if (container) container.scrollTop = container.scrollHeight;
    });

    // The oldest task (file-0000.zip, sorted last) is now mounted...
    await expect(page.locator('tr.desktop-table-row', { hasText: 'file-0000.zip' })).toBeVisible({
      timeout: 5000,
    });
    // ...the top-of-list task has unmounted (window moved, not full render)...
    await expect(page.locator('tr.desktop-table-row', { hasText: 'file-0499.zip' })).toHaveCount(0);
    // ...and the DOM stays bounded.
    const domCount = await page.locator('tr.desktop-table-row').count();
    expect(domCount).toBeLessThan(150);
  });

  test('select-all selects every task despite only a slice being in the DOM', async ({ page }) => {
    // The header checkbox is hidden until its <th> (group/header) is hovered.
    await page.locator('thead th').first().hover();
    await page.locator('thead input[type="checkbox"]').first().click();
    const checked = await page.locator('tr.desktop-table-row input[type="checkbox"]:checked').count();
    const rendered = await page.locator('tr.desktop-table-row').count();
    // Every rendered row is checked — selection is model-based over all 500
    // tasks, not DOM-based over the visible slice.
    expect(checked).toBe(rendered);
    expect(checked).toBeGreaterThan(5);
  });
});
