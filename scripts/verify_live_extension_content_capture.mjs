#!/usr/bin/env node
import http from 'node:http';

const CDP_BASE = process.env.NOVA_CHROME_CDP ?? 'http://localhost:9222';
const EXTENSION_ID = process.env.NOVA_CHROMIUM_EXTENSION_ID ?? 'jplpcjabfbfnmdoofcjchikfcmfbdiej';
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const DOWNLOAD_URL = `https://httpbin.org/bytes/131072?nova_content_capture=${RUN_ID}`;
const FILENAME = `nova-content-capture-${RUN_ID}.bin`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    socket.addEventListener('error', () => reject(new Error('Could not open the Chromium DevTools connection.')), { once: true });
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
    if (response.error) throw new Error(`DevTools protocol error: ${response.error.message}`);
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text ?? 'Extension expression threw.');
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

async function findLoadedExtensionPopup() {
  const targets = await cdpJson(`${CDP_BASE}/json/list`);
  const expectedUrl = `chrome-extension://${EXTENSION_ID}/popup.html`;
  const target = targets.find((candidate) => candidate?.url === expectedUrl && candidate?.webSocketDebuggerUrl);
  if (!target) throw new Error(`NOVA extension popup is not loaded at ${expectedUrl}.`);
  return target;
}

function startFixture() {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.url !== '/capture.html') {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><html><head><title>NOVA Content Capture Fixture</title></head><body>
      <a id="nova-download" href="${DOWNLOAD_URL}" download="${FILENAME}">Download fixture</a>
    </body></html>`);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not allocate fixture server port.'));
      resolve({
        pageUrl: `http://127.0.0.1:${address.port}/capture.html`,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

async function waitForCapturedReview(popupWsUrl) {
  const deadline = Date.now() + 20_000;
  let lastOutbox;
  while (Date.now() < deadline) {
    lastOutbox = await evaluate(popupWsUrl, runtimeMessage({ type: 'GET_OUTBOX_STATUS' }));
    const raw = await evaluate(popupWsUrl, `(async () => {
      const record = (await chrome.storage.local.get('nova.pairToken'))['nova.pairToken'];
      const token = typeof record === 'string' ? record : record?.token;
      const [reviewsResponse, tasksResponse] = await Promise.all([
        fetch('http://127.0.0.1:3199/v1/capture-reviews', { headers: { Authorization: 'Bearer ' + token } }),
        fetch('http://127.0.0.1:3199/v1/tasks', { headers: { Authorization: 'Bearer ' + token } }),
      ]);
      return { reviews: await reviewsResponse.json(), tasks: await tasksResponse.json() };
    })()`);
    const review = Array.isArray(raw?.reviews?.reviews)
      ? raw.reviews.reviews.find((item) => item?.url === DOWNLOAD_URL)
      : undefined;
    const task = Array.isArray(raw?.tasks?.tasks)
      ? raw.tasks.tasks.find((item) => item?.url === DOWNLOAD_URL)
      : undefined;
    if (review && !task) return { review, outbox: lastOutbox };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Content-script capture did not reach the NOVA review queue without creating a task. Last outbox state: ${JSON.stringify(lastOutbox)}`);
}

let fixture;
try {
  fixture = await startFixture();
  const popup = await findLoadedExtensionPopup();
  const bridge = await evaluate(popup.webSocketDebuggerUrl, runtimeMessage({ type: 'AUTO_CONNECT' }));
  assert(bridge?.status === 'connected' && bridge?.canSend === true, `Bridge not connected: ${JSON.stringify(bridge)}`);

  const page = await cdpJson(`${CDP_BASE}/json/new?${encodeURIComponent(fixture.pageUrl)}`, { method: 'PUT' });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const clicked = await evaluate(page.webSocketDebuggerUrl, `(() => {
    const link = document.querySelector('#nova-download');
    if (!link) throw new Error('Fixture link is missing.');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, view: window }));
    return { url: link.href, filename: link.getAttribute('download') };
  })()`);
  assert(clicked?.url === DOWNLOAD_URL, `Fixture click did not target the expected URL: ${JSON.stringify(clicked)}`);

  const received = await waitForCapturedReview(popup.webSocketDebuggerUrl);
  assert((received.outbox?.deadLetter ?? 0) === 0, `Capture reached a dead-letter state: ${JSON.stringify(received.outbox)}`);
  assert((received.outbox?.sent ?? 0) >= 1, `Capture was not handed off: ${JSON.stringify(received.outbox)}`);

  console.log(JSON.stringify({
    ok: true,
    extensionId: EXTENSION_ID,
    source: 'content-script-download-attribute',
    fixturePage: fixture.pageUrl,
    candidateUrl: DOWNLOAD_URL,
    pendingReview: { id: received.review.reviewId, url: received.review.url },
    outbox: received.outbox,
  }, null, 2));
} catch (error) {
  console.error(`Live content-script capture acceptance failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (fixture?.close) await fixture.close();
}
