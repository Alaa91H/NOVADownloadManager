#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CDP_BASE = process.env.NOVA_CHROME_CDP ?? 'http://localhost:9222';
const EXTENSION_ID = process.env.NOVA_CHROMIUM_EXTENSION_ID ?? 'jplpcjabfbfnmdoofcjchikfcmfbdiej';
const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
const NOVA_BIN = process.env.NOVA_TEST_BIN ?? `${PROJECT_ROOT}src-tauri/target/debug/nova`;
const DAEMON_HOME = process.env.NOVA_TEST_HOME ?? '/tmp/nova-extension-live-home';
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const DOWNLOAD_URL = `https://httpbin.org/bytes/98304?nova_offline_recovery=${RUN_ID}`;
const FILENAME = `nova-offline-recovery-${RUN_ID}.bin`;

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

async function assertDaemonOffline() {
  try {
    const response = await fetch('http://127.0.0.1:3199/v1/ping', { signal: AbortSignal.timeout(1_000) });
    throw new Error(`Daemon must be stopped before recovery test; ping returned HTTP ${response.status}.`);
  } catch (error) {
    if (String(error).includes('Daemon must be stopped')) throw error;
  }
}

async function waitForDaemon() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:3199/v1/ping', { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* daemon is still booting */ }
    await delay(250);
  }
  throw new Error('Daemon did not start in time for outbox recovery.');
}

async function daemonTasks(popupWsUrl) {
  return evaluate(popupWsUrl, `(async () => {
    const record = (await chrome.storage.local.get('nova.pairToken'))['nova.pairToken'];
    const token = typeof record === 'string' ? record : record?.token;
    const response = await fetch('http://127.0.0.1:3199/v1/tasks', { headers: { Authorization: 'Bearer ' + token } });
    return response.json();
  })()`);
}

let fixture;
let daemon;
try {
  assert(existsSync(NOVA_BIN), `Missing NOVA test binary: ${NOVA_BIN}`);
  await assertDaemonOffline();
  fixture = await startFixture();

  const popup = await cdpJson(`${CDP_BASE}/json/new?${encodeURIComponent(`chrome-extension://${EXTENSION_ID}/popup.html`)}`, { method: 'PUT' });
  const page = await cdpJson(`${CDP_BASE}/json/new?${encodeURIComponent(fixture.pageUrl)}`, { method: 'PUT' });
  await delay(1_000);
  await evaluate(page.webSocketDebuggerUrl, `document.querySelector('#nova-download').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, view: window }))`);

  let offlineOutbox;
  const offlineDeadline = Date.now() + 10_000;
  while (Date.now() < offlineDeadline) {
    offlineOutbox = await evaluate(popup.webSocketDebuggerUrl, runtimeMessage({ type: 'GET_OUTBOX_STATUS' }));
    if ((offlineOutbox?.failed ?? 0) >= 1 || (offlineOutbox?.pending ?? 0) >= 1) break;
    await delay(250);
  }
  assert((offlineOutbox?.deadLetter ?? 0) === 0, `Offline capture became dead-letter: ${JSON.stringify(offlineOutbox)}`);
  assert((offlineOutbox?.failed ?? 0) >= 1 || (offlineOutbox?.pending ?? 0) >= 1,
    `Offline capture was not retained for retry: ${JSON.stringify(offlineOutbox)}`);

  daemon = spawn(NOVA_BIN, ['--integration'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, HOME: DAEMON_HOME, NOVA_DAEMON_PORT: '3199' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitForDaemon();
  const reconnected = await evaluate(popup.webSocketDebuggerUrl, runtimeMessage({ type: 'RETRY_CONNECT' }));
  assert(reconnected?.canSend === true, `Extension did not reconnect after daemon startup: ${JSON.stringify(reconnected)}`);
  await delay(3_000);
  await evaluate(popup.webSocketDebuggerUrl, runtimeMessage({ type: 'RUN_OUTBOX_RETRY' }));

  let finalOutbox;
  let receivedTask;
  const recoveryDeadline = Date.now() + 20_000;
  while (Date.now() < recoveryDeadline) {
    finalOutbox = await evaluate(popup.webSocketDebuggerUrl, runtimeMessage({ type: 'GET_OUTBOX_STATUS' }));
    const tasks = await daemonTasks(popup.webSocketDebuggerUrl);
    receivedTask = Array.isArray(tasks?.tasks) ? tasks.tasks.find((task) => task?.url === DOWNLOAD_URL) : undefined;
    if (receivedTask && (finalOutbox?.sent ?? 0) >= 1) break;
    await delay(500);
  }
  assert((finalOutbox?.deadLetter ?? 0) === 0, `Recovered capture became dead-letter: ${JSON.stringify(finalOutbox)}`);
  assert(receivedTask, `Recovered capture did not reach daemon: ${JSON.stringify(finalOutbox)}`);

  console.log(JSON.stringify({
    ok: true,
    extensionId: EXTENSION_ID,
    offlineOutbox,
    reconnected: { status: reconnected.status, transport: reconnected.transport, canSend: reconnected.canSend },
    finalOutbox,
    receivedTask: { id: receivedTask.id, url: receivedTask.url, status: receivedTask.status },
  }, null, 2));
} catch (error) {
  console.error(`Live extension offline-recovery acceptance failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (fixture?.close) await fixture.close();
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await new Promise((resolve) => daemon.once('exit', resolve));
  }
}
