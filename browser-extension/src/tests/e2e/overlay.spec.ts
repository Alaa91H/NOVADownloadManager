import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXTENSION_DIR = path.resolve(
  process.cwd(),
  process.env.EXTENSION_UNPACKED_DIR ?? 'dist/chromium',
);
const RUN_REAL_EXTENSION_E2E = process.env.NOVA_RUN_REAL_EXTENSION_E2E === '1';
const BROWSER_LAUNCH_TIMEOUT_MS = Number(process.env.NOVA_E2E_BROWSER_LAUNCH_TIMEOUT_MS ?? 90_000);
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const EXTENSION_LAUNCH_ARGS = [
  `--disable-extensions-except=${EXTENSION_DIR}`,
  `--load-extension=${EXTENSION_DIR}`,
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--enable-extensions',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-sandbox',
  '--ozone-platform=x11',
  '--password-store=basic',
  '--use-mock-keychain',
  '--window-size=1280,900',
];

function startOverlayFixtureServer(): Promise<{ server: Server; url: string }> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/media/sample.mp4') {
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': '2097152',
        'accept-ranges': 'bytes',
      });
      response.end(Buffer.alloc(1024));
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html lang="en">
        <head><title>NOVA overlay fixture</title></head>
        <body>
          <main>
            <h1>NOVA overlay fixture</h1>
            <video controls src="/media/sample.mp4" width="640" height="360"></video>
            <a href="/media/sample.mp4" download>Download sample</a>
          </main>
        </body>
      </html>`);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function normalizePathForCompare(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function readExtensionIdFromPreferences(userDataDir: string): string | null {
  const preferencesPath = path.join(userDataDir, 'Default', 'Preferences');
  if (!fs.existsSync(preferencesPath)) return null;

  let preferences: { extensions?: { settings?: Record<string, { path?: string }> } };
  try {
    preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) as typeof preferences;
  } catch {
    return null;
  }

  const settings = preferences.extensions?.settings ?? {};
  const expectedPath = normalizePathForCompare(EXTENSION_DIR);
  for (const [extensionId, config] of Object.entries(settings)) {
    if (!EXTENSION_ID_PATTERN.test(extensionId) || !config.path) continue;
    const installedPath = path.isAbsolute(config.path)
      ? config.path
      : path.resolve(userDataDir, config.path);
    if (normalizePathForCompare(installedPath) === expectedPath) return extensionId;
  }
  return null;
}

async function waitForExtensionId(userDataDir: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const extensionId = readExtensionIdFromPreferences(userDataDir);
    if (extensionId) return extensionId;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('NOVA extension id could not be resolved from Chromium Preferences.');
}

async function closeContext(context: BrowserContext | undefined): Promise<void> {
  if (!context) return;
  await Promise.race([
    context.close(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timed out closing Chromium persistent context.')), 10_000),
    ),
  ]).catch((error) => console.warn(error instanceof Error ? error.message : error));
}

test.describe('NOVA floating overlay real content smoke', () => {
  test.skip(
    !RUN_REAL_EXTENSION_E2E,
    'Real content-script overlay smoke is opt-in. Set NOVA_RUN_REAL_EXTENSION_E2E=1 after building dist/chromium.',
  );
  test.skip(
    !fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json')),
    `Unpacked extension not found at ${EXTENSION_DIR}`,
  );

  let server: Server;
  let fixtureUrl: string;

  test.beforeAll(async () => {
    const fixture = await startOverlayFixtureServer();
    server = fixture.server;
    fixtureUrl = fixture.url;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  test('injects overlay, opens edge-aware menu, and exposes picker controls on a media page', async ({ browserName }, testInfo) => {
    testInfo.annotations.push({ type: 'browser', description: browserName });
    testInfo.setTimeout(BROWSER_LAUNCH_TIMEOUT_MS + 45_000);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-overlay-e2e-'));
    let context: BrowserContext | undefined;

    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: EXTENSION_LAUNCH_ARGS,
        timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      });
      await waitForExtensionId(userDataDir, 30_000);

      const page = await context.newPage();
      await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
      const overlay = page.locator('#nova-video-download-overlay-host');
      await expect(overlay).toBeVisible();

      const box = await overlay.boundingBox();
      expect(box?.x ?? 0).toBeGreaterThan(1000);
      expect(box?.y ?? 9999).toBeLessThan(140);

      await overlay.locator('.nova-video-download-trigger').click();
      await expect(overlay.locator('.nova-video-download-actions')).toBeVisible();
      await expect(overlay.locator('.nova-video-download-label')).toBeVisible();
      await expect(overlay.locator('.nova-video-download-close')).toBeVisible();

      await overlay.locator('.nova-video-download-label').click();
      const picker = page.locator('#nova-candidate-picker-host');
      await expect(picker).toBeVisible();
      await expect(picker.locator('.nova-picker-tool')).toHaveCount(2);
      await expect(picker.locator('.nova-picker-send')).toBeVisible();
    } finally {
      await closeContext(context);
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
