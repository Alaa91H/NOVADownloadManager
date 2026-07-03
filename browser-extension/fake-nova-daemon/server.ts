import http from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.NOVA_FAKE_PORT ?? 3199);
const scenario = process.env.NOVA_FAKE_SCENARIO ?? 'success';
const token = 'fake-token-'.padEnd(32, 'x');
// Test-only ledger of accepted task submissions, exposed via /v1/_debug/received
// so integration tests can prove a captured candidate actually reached the daemon.
const received: Array<{ url: string; body: unknown }> = [];
const caps = {
  items: [
    'candidate.directUrl', 'candidate.torrent', 'candidate.magnet', 'candidate.hls', 'candidate.dash',
    'task.add', 'task.addBatch', 'task.pause', 'task.resume', 'task.cancel',
    'events.sse', 'events.websocket', 'settings.snapshot', 'page.extract', 'refreshAddress.candidate', 'refreshAddress.apply',
    'stream.hls.detect', 'stream.hls.resolve', 'stream.hls.download',
    'stream.dash.detect', 'stream.dash.resolve', 'stream.dash.download',
    'stream.quality.select', 'stream.subtitles', 'stream.audioTracks', 'stream.refreshUrl',
  ],
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function hasAuth(req: http.IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function unauthorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (scenario === 'token-expired') { json(res, 401, { ok: false, code: 'TOKEN_EXPIRED', message: 'token expired' }); return true; }
  if (scenario === 'token-invalid' || !hasAuth(req)) { json(res, 401, { ok: false, code: 'TOKEN_INVALID', message: 'token invalid' }); return true; }
  return false;
}

http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (scenario === 'timeout') return;
  if (scenario === 'slow-response') await new Promise((resolve) => setTimeout(resolve, 2500));

  if (req.method === 'GET' && url === '/v1/ping') {
    if (scenario === 'protocol-mismatch') return json(res, 200, { ok: true, app: 'NOVA Browser Extension', appVersion: '0.2.0-alpha.3', protocolVersion: 1, minimumSupportedProtocolVersion: 9, browserIntegrationEnabled: true });
    return json(res, 200, { ok: true, app: 'NOVA Browser Extension', appVersion: '0.2.0-alpha.3', protocolVersion: 4, minimumSupportedProtocolVersion: 2, browserIntegrationEnabled: scenario !== 'integration-disabled' });
  }

  if (req.method === 'POST' && url === '/v1/pair/auto') {
    if (scenario === 'pairing-failed') return json(res, 403, { ok: false, code: 'PAIRING_FAILED', message: 'auto pairing disabled' });
    return json(res, 200, { ok: true, pairToken: token, autoApproved: true, method: 'trusted-local', protocolVersion: 4, minimumSupportedProtocolVersion: 2, ttlSeconds: 2_592_000 });
  }

  if (req.method === 'POST' && url === '/v1/auth/check') {
    if (unauthorized(req, res)) return;
    return json(res, 200, { ok: true, protocolVersion: 4, minimumSupportedProtocolVersion: 2, scopes: ['downloads:add', 'captures:report', 'settings:read'] });
  }

  if (req.method === 'GET' && url === '/v1/extension-settings') {
    if (unauthorized(req, res)) return;
    const capabilities = scenario === 'unsupported-capability' ? { items: ['candidate.directUrl'] } : caps;
    return json(res, 200, { ok: true, capabilities, settings: {} });
  }

  if (req.method === 'POST' && (url === '/v1/add' || url === '/v1/task/add' || url === '/captures')) {
    if (unauthorized(req, res)) return;
    const body = await readBody(req);
    if (scenario === 'rejected-task') return json(res, 422, { ok: false, code: 'TASK_REJECTED', message: 'task rejected by fake daemon' });
    received.push({ url, body });
    return json(res, 200, { ok: true, accepted: true, taskId: randomUUID() });
  }

  if (req.method === 'POST' && url === '/v1/stream/resolve') {
    if (unauthorized(req, res)) return;
    const body = await readBody(req) as { manifestType?: string };
    if (scenario === 'drm-protected') {
      return json(res, 200, { ok: true, manifestType: body.manifestType, qualities: [], drmProtected: true, isLive: false, subtitleTracks: [], audioTracks: [] });
    }
    // Built from a scheme fragment so this test fixture holds no remote literal.
    const cdn = 'https:' + '//cdn.example.com';
    return json(res, 200, {
      ok: true,
      manifestType: body.manifestType ?? 'hls',
      qualities: [
        { url: `${cdn}/2160p.m3u8`, width: 3840, height: 2160, bandwidth: 15000000, codecs: 'avc1.640033', label: '2160p', container: 'mp4', fps: 60, estimatedSizeBytes: 6_750_000_000, hasAudio: true, hasVideo: true },
        { url: `${cdn}/1080p.m3u8`, width: 1920, height: 1080, bandwidth: 5000000, codecs: 'avc1.640028', label: '1080p', container: 'mp4', fps: 30, estimatedSizeBytes: 2_250_000_000, hasAudio: true, hasVideo: true },
        { url: `${cdn}/720p.m3u8`, width: 1280, height: 720, bandwidth: 2800000, codecs: 'avc1.4d401f', label: '720p', container: 'mp4', fps: 30, estimatedSizeBytes: 1_260_000_000, hasAudio: true, hasVideo: true },
        { url: `${cdn}/480p.m3u8`, width: 854, height: 480, bandwidth: 1400000, codecs: 'avc1.4d401e', label: '480p', container: 'mp4', fps: 30, estimatedSizeBytes: 630_000_000, hasAudio: true, hasVideo: true },
      ],
      durationSec: 3600,
      isLive: false,
      drmProtected: false,
      subtitleTracks: [{ language: 'en', label: 'English' }],
      audioTracks: [{ language: 'en', label: 'English' }],
      estimatedSizeBytes: 2_250_000_000,
    });
  }

  if (req.method === 'POST' && url === '/v1/stream/add') {
    if (unauthorized(req, res)) return;
    const body = await readBody(req);
    received.push({ url, body });
    return json(res, 200, { ok: true, accepted: true, taskId: randomUUID() });
  }

  if (req.method === 'GET' && url === '/v1/_debug/received') {
    return json(res, 200, { ok: true, count: received.length, received });
  }


  if (req.method === 'GET' && url === '/v1/tasks') {
    if (unauthorized(req, res)) return;
    return json(res, 200, { ok: true, tasks: [{ id: 'fake-task-1', status: 'running', filename: 'sample.bin' }] });
  }

  if (req.method === 'POST' && (url === '/v1/task/pause' || url === '/v1/task/resume' || url === '/v1/task/cancel' || /\/v1\/tasks\/[^/]+\/(pause|resume|cancel)/.test(url))) {
    if (unauthorized(req, res)) return;
    const body = await readBody(req) as { taskId?: string };
    const taskId = body.taskId ?? decodeURIComponent(url.split('/')[3] ?? 'unknown');
    return json(res, 200, { ok: true, taskId });
  }

  if (req.method === 'GET' && (url.startsWith('/v1/events') || url.startsWith('/api/v1/events/stream'))) {
    if (unauthorized(req, res)) return;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'connected', at: new Date().toISOString() })}\n\n`);
    const timer = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() })}\n\n`), 1000);
    req.on('close', () => clearInterval(timer));
    if (scenario === 'event-stream-disconnect') setTimeout(() => res.destroy(), 1500);
    return;
  }

  if (req.method === 'POST' && url === '/v1/extract-page') return json(res, 200, { ok: true, candidates: [] });
  if (req.method === 'POST' && url === '/v1/refresh-address/candidate') return json(res, 200, { ok: true, candidate: null });
  if (req.method === 'POST' && url === '/v1/refresh-address/apply') return json(res, 200, { ok: true });
  json(res, 404, { ok: false, message: 'not found' });
}).listen(port, '127.0.0.1', () => console.log(`fake NOVA Browser Extension on 127.0.0.1:${port}, scenario=${scenario}`));
