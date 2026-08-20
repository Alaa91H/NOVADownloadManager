#!/usr/bin/env node
import http from 'node:http';

const CDP_BASE = process.env.NOVA_CHROME_CDP ?? 'http://localhost:9222';
const EXTENSION_ID = process.env.NOVA_CHROMIUM_EXTENSION_ID ?? 'jplpcjabfbfnmdoofcjchikfcmfbdiej';
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const DOWNLOAD_URL = `https://httpbin.org/bytes/65536?nova_capture_disabled=${RUN_ID}`;
const FILENAME = `nova-capture-disabled-${RUN_ID}.bin`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cdpJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${url} failed with HTTP ${response.status}`);
  return response.json();
}

async function evaluate(wsUrl, expression) {
  const socket = new WebSocket(wsUrl);
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not open Chromium DevTools.')), { once: true });
  });
  try {
    await opened;
    const response = await new Promise((resolve, reject) => {
      const id = 1;
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for Chromium evaluation.')), 15_000);
      socket.addEventListener('message', (event) => {
        const payload = JSON.parse(String(event.data));
        if (payload.id !== id) return;
        clearTimeout(timeout);
        resolve(payload);
      });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
    });
    if (response.error) throw new Error(response.error.message);
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text ?? 'Extension expression failed.');
    return response.result?.result?.value;
  } finally {
    socket.close();
  }
}

function runtimeMessage(message) {
  return `new Promise((resolve, reject) => chrome.runtime.sendMessage(${JSON.stringify(message)}, (response) => {
    const lastError = chrome.runtime.lastError;
    if (lastError) reject(new Error(lastError.message)); else resolve(response);
  }))`;
}

function startFixture() {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.url !== '/capture.html') return response.writeHead(404).end('not found');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><a id="nova-download" href="${DOWNLOAD_URL}" download="${FILENAME}">Download fixture</a>`);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Fixture port allocation failed.'));
      resolve({
        pageUrl: `http://127.0.0.1:${address.port}/capture.html`,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(done);
        }),
      });
    });
  });
}

async function outboxJobs(popupWsUrl) {
  return evaluate(popupWsUrl, `new Promise((resolve, reject) => {
    const request = indexedDB.open('nova-outbox');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('jobs', 'readonly').objectStore('jobs').getAll();
      read.onerror = () => reject(read.error);
      read.onsuccess = () => resolve(read.result.map((job) => ({
        status: job.status,
        attempts: job.attempts,
        url: Array.isArray(job.payload) ? job.payload[0]?.url : job.payload?.url,
        source: Array.isArray(job.payload) ? job.payload[0]?.source : job.payload?.source,
      })));
    };
  })`);
}

async function daemonHasTask(popupWsUrl) {
  const raw = await evaluate(popupWsUrl, `(async () => {
    const record = (await chrome.storage.local.get('nova.pairToken'))['nova.pairToken'];
    const token = typeof record === 'string' ? record : record?.token;
    const response = await fetch('http://127.0.0.1:3199/v1/tasks', { headers: { Authorization: 'Bearer ' + token } });
    return response.json();
  })()`);
  return Array.isArray(raw?.tasks) && raw.tasks.some((task) => task?.url === DOWNLOAD_URL);
}

let fixture;
let originalSettings;
let popupWsUrl;
try {
  fixture = await startFixture();
  const popup = await cdpJson(`${CDP_BASE}/json/new?${encodeURIComponent(`chrome-extension://${EXTENSION_ID}/popup.html`)}`, { method: 'PUT' });
  popupWsUrl = popup.webSocketDebuggerUrl;
  originalSettings = await evaluate(popupWsUrl, runtimeMessage({ type: 'GET_SETTINGS' }));
  const updated = await evaluate(popupWsUrl, runtimeMessage({
    type: 'UPDATE_SETTINGS',
    settings: { capture: { downloads: false, takeoverEnabled: false, aggressiveMode: false } },
  }));
  assert(updated?.capture?.downloads === false && updated?.capture?.takeoverEnabled === false && updated?.capture?.aggressiveMode === false,
    `Capture-disable settings were not persisted: ${JSON.stringify(updated)}`);
  // Give the MV3 background and document-start content-script environments a
  // bounded propagation window; the subsequent task/outbox assertions still
  // detect any enduring policy mismatch.
  await delay(3_000);
  const stableSettings = await evaluate(popupWsUrl, runtimeMessage({ type: 'GET_SETTINGS' }));
  assert(stableSettings?.capture?.downloads === false && stableSettings?.capture?.takeoverEnabled === false && stableSettings?.capture?.aggressiveMode === false,
    `Capture-disable settings were overwritten before click: ${JSON.stringify(stableSettings)}`);

  const outboxBefore = await evaluate(popupWsUrl, runtimeMessage({ type: 'GET_OUTBOX_STATUS' }));
  const page = await cdpJson(`${CDP_BASE}/json/new?${encodeURIComponent(fixture.pageUrl)}`, { method: 'PUT' });
  await delay(1_000);
  const click = await evaluate(page.webSocketDebuggerUrl, `(() => {
    const link = document.querySelector('#nova-download');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, view: window });
    link.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, url: link.href };
  })()`);
  await delay(1_500);
  const outboxAfter = await evaluate(popupWsUrl, runtimeMessage({ type: 'GET_OUTBOX_STATUS' }));
  const jobsAfter = await outboxJobs(popupWsUrl);
  assert((outboxAfter?.sent ?? 0) === (outboxBefore?.sent ?? 0), `Disabled capture created a sent handoff: before=${JSON.stringify(outboxBefore)}, after=${JSON.stringify(outboxAfter)}, jobs=${JSON.stringify(jobsAfter)}`);
  assert((outboxAfter?.pending ?? 0) === (outboxBefore?.pending ?? 0), `Disabled capture queued a handoff: before=${JSON.stringify(outboxBefore)}, after=${JSON.stringify(outboxAfter)}`);
  assert((await daemonHasTask(popupWsUrl)) === false, 'Disabled capture still created a desktop task.');

  console.log(JSON.stringify({
    ok: true,
    extensionId: EXTENSION_ID,
    captureDisabled: true,
    defaultPrevented: click.defaultPrevented,
    stableSettings: { downloads: stableSettings.capture.downloads, takeoverEnabled: stableSettings.capture.takeoverEnabled, aggressiveMode: stableSettings.capture.aggressiveMode },
    outboxBefore,
    outboxAfter,
    jobsAfter,
  }, null, 2));
} catch (error) {
  console.error(`Live disabled-capture acceptance failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (popupWsUrl && originalSettings) {
    await evaluate(popupWsUrl, runtimeMessage({ type: 'UPDATE_SETTINGS', settings: originalSettings })).catch(() => {});
  }
  if (fixture?.close) await fixture.close();
}
