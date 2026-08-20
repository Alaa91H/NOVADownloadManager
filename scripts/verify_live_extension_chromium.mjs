#!/usr/bin/env node
import process from 'node:process';

const CDP_BASE = process.env.NOVA_CHROME_CDP ?? 'http://localhost:9222';
const EXTENSION_ID = process.env.NOVA_CHROMIUM_EXTENSION_ID ?? 'jplpcjabfbfnmdoofcjchikfcmfbdiej';
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const TEST_URL = process.env.NOVA_LIVE_CAPTURE_URL ?? `https://httpbin.org/bytes/262144?nova_live_run=${RUN_ID}`;
const TEST_FILENAME = `nova-live-extension-capture-${RUN_ID}.bin`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${url} failed with HTTP ${response.status}`);
  return response.json();
}

async function createPopupTarget() {
  const popupUrl = `chrome-extension://${EXTENSION_ID}/popup.html`;
  return json(`${CDP_BASE}/json/new?${encodeURIComponent(popupUrl)}`, { method: 'PUT' });
}

async function evaluate(wsUrl, expression) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not open the Chromium DevTools connection.')), { once: true });
  });
  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(String(event.data));
    const resolver = pending.get(payload.id);
    if (!resolver) return;
    pending.delete(payload.id);
    resolver(payload);
  });

  try {
    await opened;
    const id = nextId++;
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Timed out waiting for Chromium to evaluate an extension runtime message.'));
      }, 20_000);
      pending.set(id, (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      }));
    });
    if (response.error) throw new Error(`DevTools protocol error: ${response.error.message}`);
    if (response.result?.exceptionDetails) {
      throw new Error(`Extension expression threw: ${response.result.exceptionDetails.text ?? 'unknown exception'}`);
    }
    return response.result?.result?.value;
  } finally {
    socket.close();
  }
}

function runtimeMessage(message) {
  return `new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(${JSON.stringify(message)}, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) reject(new Error(lastError.message));
      else resolve(response);
    });
  })`;
}

async function waitForTask(wsUrl) {
  const deadline = Date.now() + 20_000;
  let lastTasks = [];
  while (Date.now() < deadline) {
    const tasksResponse = await evaluate(wsUrl, runtimeMessage({ type: 'LIST_TASKS' }));
    lastTasks = Array.isArray(tasksResponse)
      ? tasksResponse
      : Array.isArray(tasksResponse?.tasks)
        ? tasksResponse.tasks
        : [];
    const match = lastTasks.find((task) =>
      String(task?.url ?? '') === TEST_URL ||
      String(task?.name ?? task?.filename ?? '').includes(TEST_FILENAME),
    );
    if (match) return { task: match, tasks: lastTasks };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The desktop daemon did not receive the browser capture within 20 seconds. Last task count: ${lastTasks.length}`);
}

try {
  const popup = await createPopupTarget();
  assert(typeof popup.webSocketDebuggerUrl === 'string', 'Chromium did not return a popup debugging target.');

  const connected = await evaluate(popup.webSocketDebuggerUrl, runtimeMessage({ type: 'AUTO_CONNECT' }));
  assert(connected?.status === 'connected' && connected?.canSend === true,
    `Extension did not reach a send-ready state: ${JSON.stringify(connected)}`);

  const started = await evaluate(
    popup.webSocketDebuggerUrl,
    runtimeMessage({ type: 'DOWNLOAD_DIRECT', url: TEST_URL, filename: TEST_FILENAME }),
  );
  assert(started?.ok === true && typeof started?.downloadId === 'number',
    `Extension could not start the real browser download: ${JSON.stringify(started)}`);

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const outbox = await evaluate(popup.webSocketDebuggerUrl, runtimeMessage({ type: 'GET_OUTBOX_STATUS' }));
  assert((outbox?.deadLetter ?? 0) === 0, `Capture entered outbox dead-letter state: ${JSON.stringify(outbox)}`);
  assert((outbox?.sent ?? 0) >= 1, `Capture was not handed off successfully: ${JSON.stringify(outbox)}`);

  const received = await waitForTask(popup.webSocketDebuggerUrl);
  console.log(JSON.stringify({
    ok: true,
    extensionId: EXTENSION_ID,
    bridge: { status: connected.status, transport: connected.transport, canSend: connected.canSend },
    downloadId: started.downloadId,
    outbox,
    receivedTask: { id: received.task?.id, url: received.task?.url, status: received.task?.status },
  }, null, 2));
} catch (error) {
  console.error(`Live Chromium extension acceptance failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
