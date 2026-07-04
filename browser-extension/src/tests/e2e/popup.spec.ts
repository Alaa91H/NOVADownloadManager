import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXTENSION_DIR = path.resolve(process.cwd(), process.env.EXTENSION_UNPACKED_DIR ?? 'dist/chromium');
const RUN_REAL_EXTENSION_E2E = process.env.ADM_RUN_REAL_EXTENSION_E2E === '1';
const BROWSER_LAUNCH_TIMEOUT_MS = Number(process.env.ADM_E2E_BROWSER_LAUNCH_TIMEOUT_MS ?? 90_000);
const EXTENSION_REGISTRATION_TIMEOUT_MS = Number(process.env.ADM_E2E_EXTENSION_REGISTRATION_TIMEOUT_MS ?? 30_000);
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

type RuntimeMessage = { type?: string };

function startStaticServer(root: string): Promise<{ server: Server; url: string }> {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const requestedPath = url.pathname === '/' ? '/popup.html' : url.pathname;
    const filePath = path.resolve(root, `.${requestedPath}`);

    if (!filePath.startsWith(root)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, { 'content-type': contentType(filePath) });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath);
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.png') return 'image/png';
  return 'application/octet-stream';
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function installExtensionApiMock(): void {
  const mockExtensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const responses: Record<string, unknown> = {
    GET_BRIDGE_STATE: { status: 'connected', canSend: true, transport: 'http', protocolVersion: 4 },
    GET_CANDIDATES: [],
    GET_OUTBOX_STATUS: { pending: 0, sending: 0, failed: 0, sent: 0, deadLetter: 0 },
    LIST_TASKS: [],
    GET_SETTINGS: { capture: { aggressiveMode: false } },
    RETRY_CONNECT: { status: 'connected', canSend: true, transport: 'http', protocolVersion: 4 },
    RESET_PAIRING: { status: 'connected', canSend: true, transport: 'http', protocolVersion: 4 },
  };

  const runtime = {
    id: mockExtensionId,
    lastError: undefined,
    sendMessage(message: RuntimeMessage, callback?: (response: unknown) => void): void {
      const response = responses[message?.type ?? ''] ?? {};
      if (typeof callback === 'function') setTimeout(() => callback(response), 0);
    },
    getURL(resourcePath = ''): string {
      return `chrome-extension://${mockExtensionId}/${resourcePath}`;
    },
  };
  const permissions = {
    contains(_query: unknown, callback?: (granted: boolean) => void): void {
      if (typeof callback === 'function') setTimeout(() => callback(true), 0);
    },
    request(_query: unknown, callback?: (granted: boolean) => void): void {
      if (typeof callback === 'function') setTimeout(() => callback(true), 0);
    },
  };
  const tabs = {
    create(_query: unknown, callback?: (tab: { id: number }) => void): void {
      if (typeof callback === 'function') setTimeout(() => callback({ id: 1 }), 0);
    },
  };
  const i18n = {
    getUILanguage(): string {
      return 'en-US';
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = { runtime, permissions, tabs, i18n };
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

  let preferences: { extensions?: { settings?: Record<string, { path?: string; manifest?: unknown }> } };
  try {
    preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) as typeof preferences;
  } catch {
    return null;
  }
  const settings = preferences.extensions?.settings ?? {};
  const expectedPath = normalizePathForCompare(EXTENSION_DIR);

  for (const [extensionId, config] of Object.entries(settings)) {
    if (!EXTENSION_ID_PATTERN.test(extensionId) || !config.path) continue;
    const installedPath = path.isAbsolute(config.path) ? config.path : path.resolve(userDataDir, config.path);
    if (normalizePathForCompare(installedPath) === expectedPath) return extensionId;
  }

  return null;
}

function extensionIdFromUrl(url: string): string | null {
  const extensionId = url.split('/')[2];
  return extensionId && EXTENSION_ID_PATTERN.test(extensionId) ? extensionId : null;
}

async function waitForExtensionIdFromPreferences(userDataDir: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const extensionId = readExtensionIdFromPreferences(userDataDir);
    if (extensionId) return extensionId;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

async function resolveExtensionId(context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>, userDataDir: string): Promise<string> {
  const existingWorker = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
  if (existingWorker) {
    const extensionId = extensionIdFromUrl(existingWorker.url());
    if (extensionId) return extensionId;
  }

  const extensionId = await waitForExtensionIdFromPreferences(userDataDir, EXTENSION_REGISTRATION_TIMEOUT_MS);
  if (extensionId) return extensionId;

  const registeredWorker = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
  if (registeredWorker) {
    const extensionId = extensionIdFromUrl(registeredWorker.url());
    if (extensionId) return extensionId;
  }

  const serviceWorker = await context.waitForEvent('serviceworker', { timeout: 2_500 }).catch(() => null);
  if (serviceWorker?.url().startsWith('chrome-extension://')) {
    const extensionId = extensionIdFromUrl(serviceWorker.url());
    if (extensionId) return extensionId;
  }

  throw new Error('Chromium launched, but ADM extension id could not be resolved.');
}

async function closeContext(context: BrowserContext | undefined): Promise<void> {
  if (!context) return;
  await Promise.race([
    context.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out closing Chromium persistent context.')), 10_000)),
  ]).catch((error) => console.warn(error instanceof Error ? error.message : error));
}

function removeUserDataDir(userDataDir: string): void {
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(error instanceof Error ? error.message : error);
  }
}

test.describe('ADM Extension popup artifact smoke', () => {
  test.skip(!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json')), `Unpacked extension not found at ${EXTENSION_DIR}`);

  let server: Server;
  let baseUrl: string;

  test.beforeAll(async () => {
    const started = await startStaticServer(EXTENSION_DIR);
    server = started.server;
    baseUrl = started.url;
  });

  test.afterAll(async () => {
    await closeServer(server);
  });

  test('loads the built popup and exposes connection panel actions', async ({ page }) => {
    await page.addInitScript(installExtensionApiMock);
    await page.goto(`${baseUrl}/popup.html`);

    await expect(page.getByRole('heading', { name: /ADM/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /ADM/i })).toBeVisible();
    await expect(page.getByText(/Transport/i)).toBeVisible();
    await expect(page.getByText(/Protocol/i)).toBeVisible();
    await expect(page.getByText(/Outbox/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Scan page/i })).toHaveCount(0);
  });
});

test.describe('ADM Extension real browser profile smoke', () => {
  test.skip(!RUN_REAL_EXTENSION_E2E, 'Real extension profile smoke is opt-in. Set ADM_RUN_REAL_EXTENSION_E2E=1 under a known-good headed browser runner.');
  test.skip(!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json')), `Unpacked extension not found at ${EXTENSION_DIR}`);

  test('loads the MV3 extension popup inside a persistent Chromium profile', async ({ browserName: _browserName }, testInfo) => {
    testInfo.setTimeout(BROWSER_LAUNCH_TIMEOUT_MS + EXTENSION_REGISTRATION_TIMEOUT_MS + 30_000);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-extension-e2e-'));
    let context: BrowserContext | undefined;

    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: EXTENSION_LAUNCH_ARGS,
        timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      });
      const extensionId = await resolveExtensionId(context, userDataDir);
      expect(extensionId).toBeTruthy();

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect(popup.getByRole('heading', { name: /ADM/i })).toBeVisible();
      await expect(popup.getByText(/Transport/i)).toBeVisible();
      await expect(popup.getByText(/Outbox/i)).toHaveCount(0);
    } finally {
      await closeContext(context);
      removeUserDataDir(userDataDir);
    }
  });
});
