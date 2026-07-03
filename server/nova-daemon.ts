import express, { type Request, type Response as ExpressResponse } from 'express';
import { spawn, type ChildProcessWithoutNullStreams, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type FileType = 'document' | 'program' | 'compressed' | 'video' | 'audio' | 'other';
type DownloadStatus = 'downloading' | 'completed' | 'paused' | 'queued' | 'error';
type DownloadEngine = 'aria2' | 'yt-dlp';

interface MediaOptions {
  mode?: 'video' | 'audio';
  quality?: string;
  formatSelector?: string;
  formatSort?: string;
  audioFormat?: string;
  ffmpegEnabled?: boolean;
  bitrate?: string;
  outputTemplate?: string;
  playlist?: boolean;
  playlistItems?: string;
  subtitles?: boolean;
  subtitleLanguages?: string;
  autoSubtitles?: boolean;
  embedSubtitles?: boolean;
  writeThumbnail?: boolean;
  embedThumbnail?: boolean;
  writeInfoJson?: boolean;
  writeDescription?: boolean;
  splitChapters?: boolean;
  sponsorBlock?: string;
  proxy?: string;
  cookies?: string;
  cookiesFromBrowser?: string;
  userAgent?: string;
  referer?: string;
  headers?: string;
  rateLimitKbs?: number;
  retries?: number;
  fragmentRetries?: number;
  concurrentFragments?: number;
  sleepIntervalSec?: number;
  maxSleepIntervalSec?: number;
  downloadSections?: string;
  matchFilter?: string;
  remuxFormat?: string;
  extraArgs?: string;
}

interface DirectDownloadOptions {
  userAgent?: string;
  referer?: string;
  headers?: string;
  cookies?: string;
  proxy?: string;
  username?: string;
  password?: string;
  checksum?: string;
  speedLimitKbs?: number;
  retryCount?: number;
  retryDelaySec?: number;
  timeoutSec?: number;
  connectTimeoutSec?: number;
  minSplitSize?: string;
  fileAllocation?: 'none' | 'prealloc' | 'falloc' | 'trunc';
  allowOverwrite?: boolean;
  autoFileRenaming?: boolean;
  conditionalGet?: boolean;
  remoteTime?: boolean;
  contentDisposition?: boolean;
  parameterizedUri?: boolean;
  rawOptions?: string;
}

interface NovaTask {
  id: string;
  name: string;
  url: string;
  fileType: FileType;
  status: DownloadStatus;
  sizeBytes: number;
  downloadedBytes: number;
  speedBytesPerSec: number;
  timeLeftSeconds: number;
  dateAdded: string;
  category: FileType;
  queueId: string;
  connections: number;
  resumable: boolean;
  savePath: string;
  description: string;
  segments: Array<{
    id: number;
    progress: number;
    downloadedBytes: number;
    totalBytes: number;
    active: boolean;
    speed: number;
  }>;
  referer?: string;
  engine: DownloadEngine;
  engineId: string;
  engineStatus?: string;
  errorMessage?: string;
  mediaOptions?: MediaOptions;
  directOptions?: DirectDownloadOptions;
}

interface CreateDownloadBody {
  name?: string;
  url?: string;
  fileType?: FileType;
  sizeBytes?: number;
  category?: FileType;
  queueId?: string;
  connections?: number;
  resumable?: boolean;
  savePath?: string;
  description?: string;
  referer?: string;
  startImmediately?: boolean;
  mediaOptions?: MediaOptions;
  directOptions?: DirectDownloadOptions;
}

interface BrowserExtensionConfig {
  enabled: boolean;
  token: string;
  minSizeMb: number;
  defaultFolder: string;
  categoryFolders: Partial<Record<FileType, string>>;
  userAgent: string;
}

interface BrowserCaptureBody {
  url?: string;
  pageUrl?: string;
  referrer?: string;
  fileName?: string;
  userAgent?: string;
  sizeBytes?: number;
  media?: boolean;
  startImmediately?: boolean;
  token?: string;
}

interface ExtensionCandidate {
  id?: string;
  url?: string;
  finalUrl?: string;
  pageUrl?: string;
  referrer?: string;
  source?: string;
  mediaType?: string;
  mimeType?: string;
  extension?: string;
  filename?: string;
  sizeBytes?: number;
  headers?: Record<string, string | undefined>;
  variants?: Array<{ url?: string; label?: string; height?: number; width?: number; bandwidth?: number }>;
  metadata?: Record<string, unknown>;
}

interface ExtensionAddBody {
  idempotencyKey?: string;
  candidate?: ExtensionCandidate;
  candidates?: ExtensionCandidate[];
  manifest?: ExtensionCandidate & { manifestType?: 'hls' | 'dash' };
  selectedQuality?: { url?: string; label?: string; height?: number; width?: number; bandwidth?: number };
}

interface ProbeResult {
  url: string;
  fileName: string;
  fileType: FileType;
  sizeBytes: number;
  resumable: boolean;
  contentType: string;
}

interface Aria2Status {
  gid: string;
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed';
  totalLength?: string;
  completedLength?: string;
  downloadSpeed?: string;
  connections?: string;
  dir?: string;
  errorMessage?: string;
  files?: Array<{
    path?: string;
    uris?: Array<{ uri?: string }>;
  }>;
}

const app = express();
const requestedPort = Number(process.env.NOVA_DAEMON_PORT || 3199);
const aria2RpcPort = Number(process.env.NOVA_ARIA2_RPC_PORT || 6800);
const aria2Secret = process.env.NOVA_ARIA2_SECRET || crypto.randomBytes(16).toString('hex');
const projectRoot = path.resolve(process.cwd());
const bundledAria2 = path.join(projectRoot, 'bin', 'aria2c.exe');
const bundledYtDlp = path.join(projectRoot, 'bin', 'yt-dlp.exe');

const aria2Bin = process.env.NOVA_ARIA2C || (fs.existsSync(bundledAria2) ? bundledAria2 : 'aria2c');
const ytDlpBin = process.env.NOVA_YTDLP || (fs.existsSync(bundledYtDlp) ? bundledYtDlp : 'yt-dlp');

let aria2Process: ChildProcessWithoutNullStreams | null = null;
const aria2Meta = new Map<string, Partial<NovaTask>>();
const mediaJobs = new Map<string, { task: NovaTask; child: ChildProcessWithoutNullStreams | null; args: string[] }>();
let ffmpegAvailable = false;
let browserExtensionConfig: BrowserExtensionConfig = {
  enabled: false,
  token: process.env.NOVA_BROWSER_TOKEN || '',
  minSizeMb: 0,
  defaultFolder: '',
  categoryFolders: {},
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NOVA/0.1.0'
};

void commandVersion('ffmpeg', ['-version']).then(r => { ffmpegAvailable = r.available; });

// Engine version checks spawn a process (yt-dlp takes 1s+), so cache successful
// results for the daemon lifetime. Failures are retried on the next call, which
// lets a missing engine recover after the user installs it.
type EngineVersionInfo = { available: boolean; version: string; error?: string };
let aria2VersionInfo: EngineVersionInfo | null = null;
let ytDlpVersionInfo: EngineVersionInfo | null = null;

async function aria2Version(): Promise<EngineVersionInfo> {
  if (!aria2VersionInfo?.available) {
    aria2VersionInfo = await commandVersion(aria2Bin, ['--version']);
  }
  return aria2VersionInfo;
}

async function ytDlpVersion(): Promise<EngineVersionInfo> {
  if (!ytDlpVersionInfo?.available) {
    ytDlpVersionInfo = await commandVersion(ytDlpBin, ['--version']);
  }
  return ytDlpVersionInfo;
}

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-NOVA-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/api/health', async (_req, res) => {
  const [aria2Info, ytDlpInfo] = await Promise.all([
    aria2Version(),
    ytDlpVersion()
  ]);

  let aria2RpcReady = false;
  let aria2RpcError = '';
  if (aria2Info.available) {
    try {
      await ensureAria2Daemon();
      await aria2Rpc('getVersion');
      aria2RpcReady = true;
    } catch (error) {
      aria2RpcError = error instanceof Error ? error.message : String(error);
    }
  }

  res.json({
    status: aria2RpcReady || ytDlpInfo.available ? 'connected' : 'degraded',
    name: 'NOVA daemon',
    version: process.env.VITE_APP_VERSION || '0.1.0',
    pid: process.pid,
    engines: {
      aria2: {
        available: aria2Info.available,
        version: aria2Info.version,
        rpcReady: aria2RpcReady,
        rpcPort: aria2RpcPort,
        error: aria2Info.error || aria2RpcError ? sanitizeEngineNames(aria2Info.error || aria2RpcError) : undefined
      },
      ytdlp: {
        available: ytDlpInfo.available,
        version: ytDlpInfo.version,
        error: ytDlpInfo.error ? sanitizeEngineNames(ytDlpInfo.error) : undefined
      }
    }
  });
});

app.get('/api/browser-extension/health', (_req, res) => {
  res.json(browserExtensionHealth());
});

app.get('/v1/ping', (_req, res) => {
  res.json({
    ok: true,
    app: 'NOVA',
    appVersion: process.env.VITE_APP_VERSION || '0.1.0',
    protocolVersion: 4,
    minimumSupportedProtocolVersion: 4,
    browserIntegrationEnabled: browserExtensionConfig.enabled || !browserExtensionConfig.token
  });
});

app.post('/v1/pair/auto', (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'Browser extension pairing is only accepted from this device.' });
    return;
  }

  const token = ensureBrowserExtensionToken();
  browserExtensionConfig = { ...browserExtensionConfig, enabled: true };
  res.json({
    ok: true,
    pairToken: token,
    autoApproved: true,
    method: 'local-loopback',
    protocolVersion: 4,
    minimumSupportedProtocolVersion: 4,
    ttlSeconds: 60 * 60 * 24 * 365
  });
});

app.post('/v1/auth/check', (req, res) => {
  const authError = extensionAuthError(req);
  if (authError) {
    res.status(authError.status).json({ code: 'AUTH_FAILED', message: authError.message });
    return;
  }

  res.json({
    ok: true,
    protocolVersion: 4,
    minimumSupportedProtocolVersion: 4,
    scopes: ['task.add', 'task.addBatch', 'task.pause', 'task.resume', 'task.cancel']
  });
});

app.get('/v1/extension-settings', (req, res) => {
  const authError = extensionAuthError(req);
  if (authError) {
    res.status(authError.status).json({ code: 'AUTH_FAILED', message: authError.message });
    return;
  }

  res.json({
    ok: true,
    capabilities: { items: extensionCapabilities() },
    settings: {
      app: 'NOVA',
      minSizeMb: browserExtensionConfig.minSizeMb,
      defaultFolder: browserExtensionConfig.defaultFolder
    }
  });
});

app.post('/v1/add', async (req, res) => {
  await handleExtensionAdd(req, res, [req.body?.candidate].filter(Boolean));
});

app.post('/captures', async (req, res) => {
  const body = req.body as ExtensionAddBody;
  await handleExtensionAdd(req, res, Array.isArray(body.candidates) ? body.candidates : [body.candidate].filter(Boolean));
});

app.post('/v1/stream/resolve', (req, res) => {
  const authError = extensionAuthError(req);
  if (authError) {
    res.status(authError.status).json({ code: 'AUTH_FAILED', message: authError.message });
    return;
  }

  const url = String(req.body?.url || '').trim();
  res.json({
    ok: Boolean(url),
    manifestType: req.body?.manifestType === 'dash' ? 'dash' : 'hls',
    qualities: url ? [{ url, label: 'Best available', hasAudio: true, hasVideo: true }] : [],
    drmProtected: false,
    subtitleTracks: [],
    audioTracks: [],
    message: url ? undefined : 'Missing manifest URL'
  });
});

app.post('/v1/stream/add', async (req, res) => {
  const body = req.body as ExtensionAddBody;
  const manifest = body.manifest
    ? {
      ...body.manifest,
      url: body.selectedQuality?.url || body.manifest.url,
      mediaType: 'manifest',
      source: body.manifest.manifestType === 'dash' ? 'dash-manifest' : 'hls-manifest'
    }
    : undefined;
  await handleExtensionAdd(req, res, manifest ? [manifest] : []);
});

app.get('/v1/tasks', async (req, res) => {
  const authError = extensionAuthError(req);
  if (authError) {
    res.status(authError.status).json({ code: 'AUTH_FAILED', message: authError.message });
    return;
  }

  try {
    const tasks = await listAllTasks();
    res.json({ ok: true, tasks: tasks.map(taskToExtensionTask) });
  } catch (error) {
    res.status(500).json({ ok: false, message: errorMessage(error) });
  }
});

app.post(['/v1/task/pause', '/v1/tasks/:id/pause'], async (req, res) => {
  await handleExtensionTaskCommand(req, res, 'pause');
});

app.post(['/v1/task/resume', '/v1/tasks/:id/resume'], async (req, res) => {
  await handleExtensionTaskCommand(req, res, 'resume');
});

app.post(['/v1/task/cancel', '/v1/tasks/:id/cancel'], async (req, res) => {
  await handleExtensionTaskCommand(req, res, 'cancel');
});

app.post('/api/browser-extension/config', (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: 'Browser extension configuration is only accepted from this device.' });
    return;
  }

  const body = req.body as Partial<BrowserExtensionConfig>;
  browserExtensionConfig = {
    enabled: Boolean(body.enabled),
    token: typeof body.token === 'string' ? body.token : browserExtensionConfig.token,
    minSizeMb: Number.isFinite(Number(body.minSizeMb)) ? Math.max(0, Number(body.minSizeMb)) : browserExtensionConfig.minSizeMb,
    defaultFolder: typeof body.defaultFolder === 'string' ? body.defaultFolder : browserExtensionConfig.defaultFolder,
    categoryFolders: typeof body.categoryFolders === 'object' && body.categoryFolders ? body.categoryFolders : browserExtensionConfig.categoryFolders,
    userAgent: typeof body.userAgent === 'string' && body.userAgent.trim() ? body.userAgent : browserExtensionConfig.userAgent
  };
  res.json(browserExtensionHealth());
});

app.post('/api/browser-extension/capture', async (req, res) => {
  try {
    const body = req.body as BrowserCaptureBody;
    const authError = browserExtensionAuthError(req, body);
    if (authError) {
      res.status(authError.status).json({ error: authError.message });
      return;
    }

    const task = await createBrowserCaptureTask(body);
    res.status(201).json({ accepted: true, task });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get('/api/downloads', async (_req, res) => {
  try {
    res.json(await listAllTasks());
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get('/api/probe', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!url) {
      res.status(400).json({ error: 'Missing url' });
      return;
    }
    res.json(await probeUrl(url));
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post('/api/downloads', async (req, res) => {
  try {
    const body = req.body as CreateDownloadBody;
    if (!body.url) {
      res.status(400).json({ error: 'Missing url' });
      return;
    }

    const task = isMediaDownload(body)
      ? await createYtDlpTask(body)
      : await createAria2Task(body);

    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post('/api/downloads/:id/pause', async (req, res) => {
  try {
    const task = await pauseTask(req.params.id);
    res.json(task);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post('/api/downloads/:id/resume', async (req, res) => {
  try {
    const task = await resumeTask(req.params.id);
    res.json(task);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.delete('/api/downloads/:id', async (req, res) => {
  try {
    await deleteTask(req.params.id);
    res.sendStatus(204);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get('/api/diagnostics', async (_req, res) => {
  const health = await commandVersion(aria2Bin, ['--version']);
  const media = await commandVersion(ytDlpBin, ['--version']);
  res.json({
    cpuUsage: Math.round(os.loadavg()[0] * 10) / 10,
    memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    diskFreeGb: 0,
    activeThreads: mediaJobs.size + (aria2Process ? 1 : 0),
    daemonVersion: '0.1.0-node',
    sqliteVersion: 'not-used',
    rustTarget: process.platform,
    osName: `${os.type()} ${os.release()}`,
    engines: {
      aria2: health,
      ytdlp: media
    },
    networkInterfaces: Object.entries(os.networkInterfaces())
      .flatMap(([name, items]) => (items || [])
        .filter(item => item.family === 'IPv4')
        .map(item => ({ name, ip: item.address, speedMbps: 0 })))
  });
});

app.get('/api/ytdlp/ffmpeg', (_req, res) => {
  res.json({ available: ffmpegAvailable });
});

app.get('/api/ytdlp/probe', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!url) {
      res.status(400).json({ error: 'Missing url' });
      return;
    }
    res.json(await probeYtDlp(url));
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get('/api/ytdlp/probe-playlist', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!url) {
      res.status(400).json({ error: 'Missing url' });
      return;
    }
    res.json(await probeYtDlpPlaylist(url));
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

const distDir = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

function startServer(port: number) {
  const server = app.listen(port, '::');
  server.on('listening', () => {
    console.log(`[NOVA daemon] listening on http://127.0.0.1:${port}`);
    try { fs.writeFileSync(path.join(projectRoot, '.nova-port'), String(port)); } catch {}
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[NOVA daemon] port ${port} is already in use. Set NOVA_DAEMON_PORT to a different port, or free port ${port}.`);
      process.exit(1);
    } else {
      console.error(`[NOVA daemon] failed to start:`, err.message);
      process.exit(1);
    }
  });
}

startServer(requestedPort);

// Warm up the engines in the background so the first health check and the
// first download do not pay the version-probe and RPC-startup cost.
void ytDlpVersion();
void aria2Version().then(info => {
  if (info.available) {
    ensureAria2Daemon().catch(() => {
      // The next health check or download will retry and report the error.
    });
  }
});

process.on('exit', () => {
  aria2Process?.kill();
  for (const job of mediaJobs.values()) {
    job.child?.kill();
  }
});

function browserExtensionHealth() {
  return {
    status: 'ready',
    enabled: browserExtensionConfig.enabled,
    paired: Boolean(browserExtensionConfig.token),
    version: process.env.VITE_APP_VERSION || '0.1.0',
    captureEndpoint: '/api/browser-extension/capture',
    directDownloads: true,
    mediaDownloads: true
  };
}

function isLoopbackRequest(req: Request): boolean {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address === 'localhost';
}

function browserExtensionAuthError(req: Request, body: BrowserCaptureBody): { status: number; message: string } | null {
  if (!browserExtensionConfig.enabled) {
    return { status: 403, message: 'Browser extension capture is disabled in NOVA.' };
  }
  if (!browserExtensionConfig.token) {
    return { status: 401, message: 'Browser extension is not paired with NOVA.' };
  }

  const token = String(req.headers['x-nova-token'] || body.token || '');
  if (token !== browserExtensionConfig.token) {
    return { status: 401, message: 'Invalid NOVA browser extension token.' };
  }
  return null;
}

function ensureBrowserExtensionToken(): string {
  if (browserExtensionConfig.token) return browserExtensionConfig.token;
  browserExtensionConfig.token = `nova_token_${crypto.randomBytes(24).toString('hex')}`;
  return browserExtensionConfig.token;
}

function extensionTokenFromRequest(req: Request): string {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  return String(req.headers['x-nova-token'] || bearer || req.body?.token || '');
}

function extensionAuthError(req: Request): { status: number; message: string } | null {
  if (!browserExtensionConfig.enabled) {
    return { status: 403, message: 'Browser extension capture is disabled in NOVA.' };
  }
  if (!browserExtensionConfig.token) {
    return { status: 401, message: 'Browser extension is not paired with NOVA.' };
  }
  if (extensionTokenFromRequest(req) !== browserExtensionConfig.token) {
    return { status: 401, message: 'Invalid NOVA browser extension token.' };
  }
  return null;
}

function extensionCapabilities() {
  return [
    'candidate.directUrl',
    'candidate.hls',
    'candidate.dash',
    'task.add',
    'task.addBatch',
    'task.pause',
    'task.resume',
    'task.cancel',
    'settings.snapshot',
    'stream.hls.detect',
    'stream.hls.resolve',
    'stream.hls.download',
    'stream.dash.detect',
    'stream.dash.resolve',
    'stream.dash.download',
    'stream.quality.select',
    'stream.subtitles',
    'stream.audioTracks',
    'stream.refreshUrl'
  ];
}

async function handleExtensionAdd(req: Request, res: ExpressResponse, candidates: Array<ExtensionCandidate | undefined>) {
  const authError = extensionAuthError(req);
  if (authError) {
    res.status(authError.status).json({ ok: false, accepted: false, code: 'AUTH_FAILED', message: authError.message });
    return;
  }

  const validCandidates = candidates.filter((candidate): candidate is ExtensionCandidate => Boolean(candidate?.url || candidate?.finalUrl));
  if (validCandidates.length === 0) {
    res.status(400).json({ ok: false, accepted: false, message: 'No downloadable browser candidate was provided.' });
    return;
  }

  try {
    const tasks = [];
    for (const candidate of validCandidates) {
      tasks.push(await createTaskFromExtensionCandidate(candidate));
    }
    res.status(201).json({
      ok: true,
      accepted: true,
      taskId: tasks[0]?.id,
      taskIds: tasks.map(task => task.id),
      message: `Accepted ${tasks.length} browser candidate${tasks.length === 1 ? '' : 's'}.`
    });
  } catch (error) {
    res.status(500).json({ ok: false, accepted: false, message: errorMessage(error) });
  }
}

async function handleExtensionTaskCommand(req: Request, res: ExpressResponse, command: 'pause' | 'resume' | 'cancel') {
  const authError = extensionAuthError(req);
  if (authError) {
    res.status(authError.status).json({ ok: false, message: authError.message });
    return;
  }

  const taskId = String(req.params.id || req.body?.taskId || '').trim();
  if (!taskId) {
    res.status(400).json({ ok: false, message: 'Missing task id.' });
    return;
  }

  try {
    if (command === 'pause') {
      const task = await pauseTask(taskId);
      res.json({ ok: true, taskId: task.id });
      return;
    }
    if (command === 'resume') {
      const task = await resumeTask(taskId);
      res.json({ ok: true, taskId: task.id });
      return;
    }
    await deleteTask(taskId);
    res.json({ ok: true, taskId });
  } catch (error) {
    res.status(500).json({ ok: false, taskId, message: errorMessage(error) });
  }
}

async function createTaskFromExtensionCandidate(candidate: ExtensionCandidate): Promise<NovaTask> {
  const url = String(candidate.finalUrl || candidate.url || '').trim();
  if (!/^https?:\/\//i.test(url) && !/^magnet:/i.test(url)) {
    throw new Error('Only HTTP, HTTPS, and magnet links can be captured from the browser extension.');
  }

  const headerFileName = fileNameFromContentDisposition(String(candidate.headers?.contentDisposition || ''));
  const fileName = sanitizeFileName(candidate.filename || headerFileName || fileNameFromUrl(url));
  const media = isExtensionMediaCandidate(candidate, url);
  const fileType = media ? mapExtensionMediaType(candidate.mediaType, url, fileName) : mapExtensionMediaType(candidate.mediaType, url, fileName);
  const targetFolder = browserExtensionConfig.categoryFolders[fileType]
    || browserExtensionConfig.defaultFolder
    || path.join(os.homedir(), 'Downloads', 'NOVA', media ? 'Media' : 'Browser');
  const referer = candidate.referrer || candidate.pageUrl || undefined;
  const sizeBytes = Number.isFinite(Number(candidate.sizeBytes))
    ? Math.max(0, Number(candidate.sizeBytes))
    : sizeFromExtensionHeaders(candidate.headers);
  const minSizeBytes = Math.round(browserExtensionConfig.minSizeMb * 1024 * 1024);
  if (minSizeBytes > 0 && sizeBytes > 0 && sizeBytes < minSizeBytes) {
    throw new Error(`Captured link is smaller than the configured minimum size (${browserExtensionConfig.minSizeMb} MB).`);
  }

  if (media) {
    return createYtDlpTask({
      name: fileName || 'Media download',
      url,
      fileType,
      sizeBytes,
      category: fileType,
      savePath: targetFolder,
      queueId: 'main',
      description: 'Captured from NOVA browser extension',
      referer,
      startImmediately: true,
      mediaOptions: {
        mode: fileType === 'audio' ? 'audio' : 'video',
        quality: 'best',
        ffmpegEnabled: true,
        outputTemplate: '%(title)s.%(ext)s',
        referer,
        userAgent: browserExtensionConfig.userAgent,
        headers: extensionHeadersToLines(candidate.headers),
        playlist: url.includes('list=')
      }
    });
  }

  return createAria2Task({
    name: fileName,
    url,
    fileType,
    sizeBytes,
    category: fileType,
    savePath: path.join(targetFolder, fileName),
    queueId: 'main',
    connections: 0,
    resumable: true,
    description: 'Captured from NOVA browser extension',
    referer,
    startImmediately: true,
    directOptions: {
      referer,
      userAgent: browserExtensionConfig.userAgent,
      headers: extensionHeadersToLines(candidate.headers),
      contentDisposition: true,
      remoteTime: true
    }
  });
}

function isExtensionMediaCandidate(candidate: ExtensionCandidate, url: string): boolean {
  return candidate.mediaType === 'video'
    || candidate.mediaType === 'audio'
    || candidate.mediaType === 'manifest'
    || candidate.source === 'hls-manifest'
    || candidate.source === 'dash-manifest'
    || isMediaUrl(url);
}

function mapExtensionMediaType(mediaType: string | undefined, url: string, fileName: string): FileType {
  if (mediaType === 'video' || mediaType === 'manifest') return 'video';
  if (mediaType === 'audio') return 'audio';
  if (mediaType === 'document') return 'document';
  if (mediaType === 'archive') return 'compressed';
  if (mediaType === 'app') return 'program';
  return inferFileType(fileName || url);
}

function extensionHeadersToLines(headers: ExtensionCandidate['headers']): string {
  if (!headers) return '';
  return Object.entries(headers)
    .filter((entry): entry is [string, string] => Boolean(entry[1]) && isForwardableExtensionHeader(entry[0]))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function isForwardableExtensionHeader(key: string): boolean {
  return /^[A-Z][A-Za-z0-9-]*$/.test(key)
    && !['Content-Length', 'Content-Range', 'Content-Disposition', 'Accept-Ranges', 'ETag', 'Last-Modified'].includes(key);
}

function sizeFromExtensionHeaders(headers: ExtensionCandidate['headers']): number {
  const direct = Number(headers?.contentLength || 0);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct);

  const ranged = String(headers?.contentRange || '').match(/\/(\d+)\s*$/)?.[1];
  const rangeSize = Number(ranged || 0);
  return Number.isFinite(rangeSize) && rangeSize > 0 ? Math.round(rangeSize) : 0;
}

function taskToExtensionTask(task: NovaTask) {
  return {
    id: task.id,
    name: task.name,
    url: task.url,
    status: task.status,
    downloadedBytes: task.downloadedBytes,
    sizeBytes: task.sizeBytes,
    speedBytesPerSec: task.speedBytesPerSec,
    savePath: task.savePath,
    engine: task.engine,
    errorMessage: task.errorMessage
  };
}

async function createBrowserCaptureTask(body: BrowserCaptureBody): Promise<NovaTask> {
  const url = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Only HTTP and HTTPS links can be captured from the browser extension.');
  }

  const fileName = sanitizeFileName(body.fileName || fileNameFromUrl(url));
  const sizeBytes = Number.isFinite(Number(body.sizeBytes)) ? Math.max(0, Number(body.sizeBytes)) : 0;
  const minSizeBytes = Math.round(browserExtensionConfig.minSizeMb * 1024 * 1024);
  if (minSizeBytes > 0 && sizeBytes > 0 && sizeBytes < minSizeBytes) {
    throw new Error(`Captured link is smaller than the configured minimum size (${browserExtensionConfig.minSizeMb} MB).`);
  }

  const media = Boolean(body.media) || isMediaUrl(url);
  const fileType = media ? 'video' : inferFileType(fileName || url);
  const targetFolder = browserExtensionConfig.categoryFolders[fileType]
    || browserExtensionConfig.defaultFolder
    || path.join(os.homedir(), 'Downloads', 'NOVA', media ? 'Media' : 'Browser');
  const referer = body.referrer || body.pageUrl || undefined;

  return media
    ? createYtDlpTask({
      name: fileName || 'Media download',
      url,
      fileType,
      sizeBytes,
      category: fileType,
      savePath: targetFolder,
      queueId: 'main',
      description: 'Captured from browser extension',
      referer,
      startImmediately: body.startImmediately !== false,
      mediaOptions: {
        mode: 'video',
        quality: 'best',
        ffmpegEnabled: true,
        outputTemplate: '%(title)s.%(ext)s',
        referer,
        userAgent: body.userAgent || browserExtensionConfig.userAgent,
        playlist: url.includes('list=')
      }
    })
    : createAria2Task({
      name: fileName,
      url,
      fileType,
      sizeBytes,
      category: fileType,
      savePath: path.join(targetFolder, fileName),
      queueId: 'main',
      connections: 0,
      resumable: true,
      description: 'Captured from browser extension',
      referer,
      startImmediately: body.startImmediately !== false,
      directOptions: {
        referer,
        userAgent: body.userAgent || browserExtensionConfig.userAgent,
        contentDisposition: true,
        remoteTime: true
      }
    });
}

async function createAria2Task(body: CreateDownloadBody): Promise<NovaTask> {
  await ensureAria2Daemon();

  const target = resolveTarget(body.savePath, body.name || fileNameFromUrl(body.url || 'download.bin'));
  fs.mkdirSync(target.dir, { recursive: true });
  const connections = normalizeConnections(body.connections);
  const directOptions = body.directOptions || {};
  const options: Record<string, string | string[]> = {
    dir: target.dir,
    out: target.fileName,
    continue: body.resumable === false ? 'false' : 'true',
    split: String(connections),
    'max-connection-per-server': String(connections),
    'min-split-size': directOptions.minSplitSize || '1M',
    'auto-file-renaming': String(directOptions.autoFileRenaming ?? false),
    pause: body.startImmediately === false ? 'true' : 'false'
  };

  if (directOptions.allowOverwrite !== undefined) {
    options['allow-overwrite'] = String(directOptions.allowOverwrite);
  }
  if (directOptions.conditionalGet !== undefined) {
    options['conditional-get'] = String(directOptions.conditionalGet);
  }
  if (directOptions.remoteTime !== undefined) {
    options['remote-time'] = String(directOptions.remoteTime);
  }
  if (directOptions.contentDisposition !== undefined) {
    options['content-disposition-default-utf8'] = String(directOptions.contentDisposition);
  }
  if (directOptions.parameterizedUri !== undefined) {
    options['parameterized-uri'] = String(directOptions.parameterizedUri);
  }
  if (directOptions.fileAllocation) {
    options['file-allocation'] = directOptions.fileAllocation;
  }
  if (directOptions.userAgent) {
    options['user-agent'] = directOptions.userAgent;
  }
  const referer = directOptions.referer || body.referer;
  if (referer) {
    options.referer = referer;
  }
  if (directOptions.proxy) {
    options['all-proxy'] = directOptions.proxy;
  }
  if (directOptions.username) {
    options['http-user'] = directOptions.username;
  }
  if (directOptions.password) {
    options['http-passwd'] = directOptions.password;
  }
  if (directOptions.checksum) {
    options.checksum = directOptions.checksum;
  }
  if (directOptions.speedLimitKbs && directOptions.speedLimitKbs > 0) {
    options['max-download-limit'] = `${Math.round(directOptions.speedLimitKbs)}K`;
  }
  if (directOptions.retryCount && directOptions.retryCount > 0) {
    options['max-tries'] = String(Math.round(directOptions.retryCount));
  }
  if (directOptions.retryDelaySec && directOptions.retryDelaySec >= 0) {
    options['retry-wait'] = String(Math.round(directOptions.retryDelaySec));
  }
  if (directOptions.timeoutSec && directOptions.timeoutSec > 0) {
    options.timeout = String(Math.round(directOptions.timeoutSec));
  }
  if (directOptions.connectTimeoutSec && directOptions.connectTimeoutSec > 0) {
    options['connect-timeout'] = String(Math.round(directOptions.connectTimeoutSec));
  }

  const headers = parseHeaderLines(directOptions.headers);
  if (directOptions.cookies) {
    headers.push(`Cookie: ${directOptions.cookies}`);
  }
  if (headers.length > 0) {
    options.header = headers;
  }
  for (const [key, value] of parseRawOptions(directOptions.rawOptions)) {
    options[key] = value;
  }

  const gid = await aria2Rpc<string>('addUri', [[body.url], options]);
  const meta: Partial<NovaTask> = {
    id: gid,
    name: body.name || target.fileName,
    url: body.url,
    fileType: body.fileType || inferFileType(target.fileName),
    category: body.category || body.fileType || inferFileType(target.fileName),
    queueId: body.queueId || 'main',
    connections,
    resumable: body.resumable ?? true,
    savePath: path.join(target.dir, target.fileName),
    description: body.description || 'Direct download',
    referer,
    engine: 'aria2',
    engineId: gid,
    directOptions
  };
  aria2Meta.set(gid, meta);

  return normalizeAria2Status(await aria2Rpc<Aria2Status>('tellStatus', [gid]), meta);
}

async function createYtDlpTask(body: CreateDownloadBody): Promise<NovaTask> {
  const version = await ytDlpVersion();
  if (!version.available) {
    throw new Error('Media engine is not available');
  }

  const id = `yt-${crypto.randomUUID()}`;
  const mediaOptions = body.mediaOptions || {};
  const saveDir = normalizeSaveDirectory(body.savePath);
  fs.mkdirSync(saveDir, { recursive: true });

  const name = body.name || (mediaOptions.playlist ? 'Media playlist' : fileNameFromUrl(body.url || 'media'));
  const task = createBaseTask({
    id,
    engine: 'yt-dlp',
    name,
    url: body.url || '',
    fileType: mediaOptions.mode === 'audio' ? 'audio' : 'video',
    savePath: saveDir,
    sizeBytes: body.sizeBytes || 0,
    queueId: body.queueId || 'main',
    description: body.description || 'Media download',
    connections: 1,
    mediaOptions,
    referer: body.referer,
    status: body.startImmediately === false ? 'queued' : 'downloading'
  });

  const args = buildYtDlpArgs(body.url || '', saveDir, mediaOptions);
  const record = { task, child: null as ChildProcessWithoutNullStreams | null, args };
  mediaJobs.set(id, record);
  if (body.startImmediately !== false) {
    startYtDlpProcess(id);
  }
  return task;
}

async function listAllTasks(): Promise<NovaTask[]> {
  const ariaTasks: NovaTask[] = [];
  if (aria2Process) {
    const active = await aria2Rpc<Aria2Status[]>('tellActive');
    const waiting = await aria2Rpc<Aria2Status[]>('tellWaiting', [0, 1000]);
    const stopped = await aria2Rpc<Aria2Status[]>('tellStopped', [0, 1000]);
    for (const item of [...active, ...waiting, ...stopped]) {
      ariaTasks.push(normalizeAria2Status(item, aria2Meta.get(item.gid) || {}));
    }
  }

  return [...ariaTasks, ...Array.from(mediaJobs.values()).map(job => job.task)];
}

async function pauseTask(id: string): Promise<NovaTask> {
  const media = mediaJobs.get(id);
  if (media) {
    media.child?.kill();
    media.child = null;
    media.task = { ...media.task, status: 'paused', speedBytesPerSec: 0, engineStatus: 'paused' };
    return media.task;
  }

  await aria2Rpc('forcePause', [id]);
  return normalizeAria2Status(await aria2Rpc<Aria2Status>('tellStatus', [id]), aria2Meta.get(id) || {});
}

async function resumeTask(id: string): Promise<NovaTask> {
  const media = mediaJobs.get(id);
  if (media) {
    if (media.task.status !== 'completed') {
      media.task = { ...media.task, status: 'downloading', engineStatus: 'resuming' };
      startYtDlpProcess(id);
    }
    return media.task;
  }

  await aria2Rpc('unpause', [id]);
  return normalizeAria2Status(await aria2Rpc<Aria2Status>('tellStatus', [id]), aria2Meta.get(id) || {});
}

async function deleteTask(id: string): Promise<void> {
  const media = mediaJobs.get(id);
  if (media) {
    media.child?.kill();
    mediaJobs.delete(id);
    return;
  }

  try {
    await aria2Rpc('forceRemove', [id]);
  } catch {
    await aria2Rpc('removeDownloadResult', [id]);
  }
  aria2Meta.delete(id);
}

async function ensureAria2Daemon(): Promise<void> {
  if (aria2Process && !aria2Process.killed) {
    return;
  }

  const version = await aria2Version();
  if (!version.available) {
    throw new Error('Direct download engine is not available');
  }

  aria2Process = spawn(aria2Bin, [
    '--enable-rpc=true',
    '--rpc-listen-all=false',
    `--rpc-listen-port=${aria2RpcPort}`,
    `--rpc-secret=${aria2Secret}`,
    '--continue=true',
    '--summary-interval=0',
    '--console-log-level=warn'
  ], { windowsHide: true });

  aria2Process.stderr.on('data', chunk => {
    console.warn(`[direct-engine] ${String(chunk).trim()}`);
  });
  aria2Process.on('exit', () => {
    aria2Process = null;
  });

  for (let i = 0; i < 20; i += 1) {
    try {
      await aria2Rpc('getVersion', [], 700);
      return;
    } catch {
      await delay(150);
    }
  }
  throw new Error('Direct download engine did not become ready in time');
}

async function aria2Rpc<T = unknown>(method: string, params: unknown[] = [], timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;

  try {
    response = await fetch(`http://127.0.0.1:${aria2RpcPort}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: `aria2.${method}`,
        params: [`token:${aria2Secret}`, ...params]
      })
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Direct download engine command timed out');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Direct download command failed with HTTP ${response.status}`);
  }

  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error) {
    throw new Error(payload.error.message ? `Direct download command failed: ${sanitizeEngineNames(payload.error.message)}` : `Direct download command ${method} failed`);
  }
  return payload.result as T;
}

function startYtDlpProcess(id: string): void {
  const record = mediaJobs.get(id);
  if (!record || record.child) {
    return;
  }

  const child = spawn(ytDlpBin, record.args, { windowsHide: true });
  record.child = child;
  record.task = { ...record.task, status: 'downloading', engineStatus: 'running' };

  child.stdout.on('data', chunk => updateYtDlpProgress(record.task.id, String(chunk)));
  child.stderr.on('data', chunk => updateYtDlpProgress(record.task.id, String(chunk)));
  child.on('exit', code => {
    const current = mediaJobs.get(id);
    if (!current) return;
    current.child = null;
    if (code === 0) {
      current.task = {
        ...current.task,
        status: 'completed',
        downloadedBytes: current.task.sizeBytes || current.task.downloadedBytes,
        speedBytesPerSec: 0,
        timeLeftSeconds: 0,
        engineStatus: 'complete',
        segments: buildSegments(1, current.task.sizeBytes || current.task.downloadedBytes, current.task.sizeBytes || current.task.downloadedBytes, false, 0)
      };
    } else if (current.task.status !== 'paused') {
      current.task = {
        ...current.task,
        status: 'error',
        speedBytesPerSec: 0,
        engineStatus: `exit-${code}`,
        errorMessage: `Media engine exited with code ${code}`
      };
    }
  });
}

function updateYtDlpProgress(id: string, text: string): void {
  const record = mediaJobs.get(id);
  if (!record) return;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const destination = line.match(/Destination:\s+(.+)$/i);
    if (destination?.[1]) {
      record.task = {
        ...record.task,
        savePath: destination[1].trim(),
        name: path.basename(destination[1].trim()) || record.task.name
      };
    }

    const percent = line.match(/(\d+(?:\.\d+)?)%/);
    const total = line.match(/of\s+([0-9.]+\s*[KMGTP]?i?B)/i);
    const speed = line.match(/at\s+([0-9.]+\s*[KMGTP]?i?B)\/s/i);
    const eta = line.match(/ETA\s+([0-9:]+)/i);

    if (percent) {
      const percentValue = Number(percent[1]);
      const totalBytes = total ? parseByteAmount(total[1]) : record.task.sizeBytes;
      const downloadedBytes = totalBytes > 0
        ? Math.round((percentValue / 100) * totalBytes)
        : record.task.downloadedBytes;
      const speedBytesPerSec = speed ? parseByteAmount(speed[1]) : record.task.speedBytesPerSec;
      record.task = {
        ...record.task,
        sizeBytes: totalBytes || record.task.sizeBytes,
        downloadedBytes,
        speedBytesPerSec,
        timeLeftSeconds: eta ? parseEta(eta[1]) : record.task.timeLeftSeconds,
        segments: buildSegments(1, totalBytes || record.task.sizeBytes || downloadedBytes, downloadedBytes, true, speedBytesPerSec),
        engineStatus: 'downloading'
      };
    }
  }
}

function normalizeAria2Status(item: Aria2Status, meta: Partial<NovaTask>): NovaTask {
  const file = item.files?.[0];
  const url = meta.url || file?.uris?.[0]?.uri || '';
  const filePath = file?.path || meta.savePath || '';
  const totalLength = Number(item.totalLength || meta.sizeBytes || 0);
  const completedLength = Number(item.completedLength || 0);
  const speed = Number(item.downloadSpeed || 0);
  const name = meta.name || (filePath ? path.basename(filePath) : fileNameFromUrl(url));
  const status = mapAriaStatus(item.status);
  const connections = Number(item.connections || meta.connections || 1);

  return createBaseTask({
    id: item.gid,
    engine: 'aria2',
    name,
    url,
    fileType: meta.fileType || inferFileType(name),
    status,
    sizeBytes: totalLength,
    downloadedBytes: status === 'completed' ? totalLength : completedLength,
    speedBytesPerSec: speed,
    timeLeftSeconds: speed > 0 && totalLength > completedLength ? Math.ceil((totalLength - completedLength) / speed) : 0,
    dateAdded: meta.dateAdded,
    category: meta.category || inferFileType(name),
    queueId: meta.queueId || 'main',
    connections,
    resumable: meta.resumable ?? true,
    savePath: filePath || path.join(item.dir || '', name),
    description: meta.description || 'Direct download',
    segments: buildSegments(connections, totalLength, completedLength, status === 'downloading', speed),
    referer: meta.referer,
    engineStatus: item.status,
    errorMessage: item.errorMessage
  });
}

function createBaseTask(input: Partial<NovaTask> & Pick<NovaTask, 'id' | 'engine' | 'name' | 'url'>): NovaTask {
  const total = input.sizeBytes || 0;
  const downloaded = input.downloadedBytes || 0;
  const status = input.status || 'queued';
  return {
    id: input.id,
    name: input.name,
    url: input.url,
    fileType: input.fileType || inferFileType(input.name),
    status,
    sizeBytes: total,
    downloadedBytes: downloaded,
    speedBytesPerSec: input.speedBytesPerSec || 0,
    timeLeftSeconds: input.timeLeftSeconds || 0,
    dateAdded: input.dateAdded || new Date().toISOString().replace('T', ' ').slice(0, 16),
    category: input.category || input.fileType || inferFileType(input.name),
    queueId: input.queueId || 'main',
    connections: input.connections || 1,
    resumable: input.resumable ?? true,
    savePath: input.savePath || '',
    description: input.description || '',
    segments: input.segments || buildSegments(input.connections || 1, total, downloaded, status === 'downloading', input.speedBytesPerSec || 0),
    referer: input.referer,
    engine: input.engine,
    engineId: input.engineId || input.id,
    engineStatus: input.engineStatus,
    errorMessage: input.errorMessage,
    mediaOptions: input.mediaOptions
  };
}

function buildYtDlpArgs(url: string, saveDir: string, mediaOptions: MediaOptions): string[] {
  const args = [
    '--newline',
    '--no-color',
    '--continue',
    '-P',
    saveDir,
    '-o',
    mediaOptions.outputTemplate || '%(title)s.%(ext)s'
  ];

  if (mediaOptions.userAgent) {
    args.push('--user-agent', mediaOptions.userAgent);
  }
  if (mediaOptions.referer) {
    args.push('--referer', mediaOptions.referer);
  }
  if (mediaOptions.proxy) {
    args.push('--proxy', mediaOptions.proxy);
  }
  for (const header of parseHeaderLines(mediaOptions.headers)) {
    args.push('--add-header', header);
  }
  if (mediaOptions.cookies) {
    if (fs.existsSync(mediaOptions.cookies)) {
      args.push('--cookies', mediaOptions.cookies);
    } else {
      args.push('--add-header', `Cookie: ${mediaOptions.cookies}`);
    }
  }
  if (mediaOptions.cookiesFromBrowser) {
    args.push('--cookies-from-browser', mediaOptions.cookiesFromBrowser);
  }
  if (mediaOptions.rateLimitKbs && mediaOptions.rateLimitKbs > 0) {
    args.push('--limit-rate', `${Math.round(mediaOptions.rateLimitKbs)}K`);
  }
  if (mediaOptions.retries && mediaOptions.retries > 0) {
    args.push('--retries', String(Math.round(mediaOptions.retries)));
  }
  if (mediaOptions.fragmentRetries && mediaOptions.fragmentRetries > 0) {
    args.push('--fragment-retries', String(Math.round(mediaOptions.fragmentRetries)));
  }
  if (mediaOptions.concurrentFragments && mediaOptions.concurrentFragments > 0) {
    args.push('--concurrent-fragments', String(Math.round(mediaOptions.concurrentFragments)));
  }
  if (mediaOptions.sleepIntervalSec && mediaOptions.sleepIntervalSec >= 0) {
    args.push('--sleep-interval', String(Math.round(mediaOptions.sleepIntervalSec)));
  }
  if (mediaOptions.maxSleepIntervalSec && mediaOptions.maxSleepIntervalSec >= 0) {
    args.push('--max-sleep-interval', String(Math.round(mediaOptions.maxSleepIntervalSec)));
  }
  if (mediaOptions.matchFilter) {
    args.push('--match-filter', mediaOptions.matchFilter);
  }
  if (mediaOptions.downloadSections) {
    args.push('--download-sections', mediaOptions.downloadSections);
  }
  if (mediaOptions.subtitles) {
    args.push('--write-subs');
  }
  if (mediaOptions.autoSubtitles) {
    args.push('--write-auto-subs');
  }
  if (mediaOptions.subtitleLanguages) {
    args.push('--sub-langs', mediaOptions.subtitleLanguages);
  }
  if (mediaOptions.embedSubtitles) {
    args.push('--embed-subs');
  }
  if (mediaOptions.writeThumbnail) {
    args.push('--write-thumbnail');
  }
  if (mediaOptions.embedThumbnail) {
    args.push('--embed-thumbnail');
  }
  if (mediaOptions.writeInfoJson) {
    args.push('--write-info-json');
  }
  if (mediaOptions.writeDescription) {
    args.push('--write-description');
  }
  if (mediaOptions.splitChapters) {
    args.push('--split-chapters');
  }
  if (mediaOptions.sponsorBlock) {
    args.push('--sponsorblock-remove', mediaOptions.sponsorBlock);
  }
  if (mediaOptions.formatSort) {
    args.push('--format-sort', mediaOptions.formatSort);
  }

  if (mediaOptions.playlist || mediaOptions.playlistItems) {
    args.push('--yes-playlist');
    if (mediaOptions.playlistItems) {
      args.push('--playlist-items', mediaOptions.playlistItems);
    }
  } else {
    args.push('--no-playlist');
  }

  if (mediaOptions.mode === 'audio') {
    args.push('-x', '--audio-format', mediaOptions.audioFormat || 'mp3');
    if (mediaOptions.bitrate) {
      args.push('--audio-quality', mediaOptions.bitrate);
    }
  } else {
    args.push('-f', mediaOptions.formatSelector || formatSelector(mediaOptions.quality || 'best'));
    if (mediaOptions.ffmpegEnabled !== false) {
      args.push('--merge-output-format', 'mp4');
    }
    if (mediaOptions.remuxFormat) {
      args.push('--remux-video', mediaOptions.remuxFormat);
    }
  }

  args.push(...splitCommandLine(mediaOptions.extraArgs || ''));
  args.push(url);
  return args;
}

function parseHeaderLines(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.includes(':') ? line : line.replace(/^([^=]+)=(.*)$/u, '$1: $2'));
}

function parseRawOptions(value: string | undefined): Array<[string, string]> {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const index = line.indexOf('=');
      if (index === -1) return [line, 'true'] as [string, string];
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as [string, string];
    })
    .filter(([key]) => key.length > 0);
}

function splitCommandLine(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) args.push(current);
  return args;
}

function formatSelector(quality: string): string {
  if (quality === 'best') {
    return 'bv*+ba/b';
  }
  const match = quality.match(/^(\d+)p/);
  if (!match) {
    return 'bv*+ba/b';
  }
  return `bv*[height<=${match[1]}]+ba/b[height<=${match[1]}]`;
}

function isMediaDownload(body: CreateDownloadBody): boolean {
  if (body.mediaOptions) return true;
  const url = body.url || '';
  return isMediaUrl(url);
}

function isMediaUrl(url: string): boolean {
  return /(?:youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|soundcloud\.com|instagram\.com|x\.com|twitter\.com)/i.test(url)
    || /\.(m3u8|mpd)(?:[?#].*)?$/i.test(url);
}

async function probeUrl(url: string): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'NOVA/0.1.0' }
    });
  } catch {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'Range': 'bytes=0-0',
        'User-Agent': 'NOVA/0.1.0'
      }
    });
  }

  if (!response.ok && response.status !== 206) {
    throw new Error(`Probe failed with HTTP ${response.status}`);
  }

  const contentDisposition = response.headers.get('content-disposition') || '';
  const contentType = response.headers.get('content-type') || '';
  const contentRange = response.headers.get('content-range') || '';
  const contentLength = response.headers.get('content-length') || '';
  const rangedTotal = contentRange.match(/\/(\d+)$/)?.[1];
  const fileName = fileNameFromContentDisposition(contentDisposition) || fileNameFromUrl(response.url || url);
  const sizeBytes = Number(rangedTotal || contentLength || 0);
  const acceptRanges = (response.headers.get('accept-ranges') || '').toLowerCase();

  return {
    url: response.url || url,
    fileName,
    fileType: inferFileType(fileName || url),
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
    resumable: acceptRanges.includes('bytes') || response.status === 206,
    contentType
  };
}

async function probeYtDlpPlaylist(url: string) {
  const version = await ytDlpVersion();
  if (!version.available) {
    throw new Error('Media engine is not available');
  }

  return new Promise<{
    title: string;
    webpageUrl: string;
    entries: Array<{ id: string; title: string; url: string; duration: number; durationString: string; thumbnail: string; index: number }>;
  }>((resolve, reject) => {
    const args = ['--dump-json', '--flat-playlist', '--skip-download', '--yes-playlist', url];
    const child = spawn(ytDlpBin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', error => reject(new Error(error.message)));
    child.on('exit', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Media engine exited with code ${code}`));
        return;
      }
      try {
        let title = '';
        let webpageUrl = url;
        const entries: Array<{ id: string; title: string; url: string; duration: number; durationString: string; thumbnail: string; index: number }> = [];

        for (const line of stdout.trim().split(/\r?\n/)) {
          if (!line.trim()) continue;
          const raw = JSON.parse(line);
          if (raw._type === 'playlist') {
            title = String(raw.title || '');
            webpageUrl = String(raw.webpage_url || url);
            continue;
          }
          entries.push({
            id: String(raw.id || ''),
            title: String(raw.title || ''),
            url: String(raw.url || raw.webpage_url || ''),
            duration: typeof raw.duration === 'number' ? raw.duration : 0,
            durationString: String(raw.duration_string || ''),
            thumbnail: String(raw.thumbnail || ''),
            index: typeof raw.playlist_index === 'number' ? raw.playlist_index : entries.length + 1,
          });
        }

        resolve({ title, webpageUrl, entries });
      } catch (e) {
        reject(new Error(`Failed to parse media playlist output: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}

async function probeYtDlp(url: string) {
  const version = await ytDlpVersion();
  if (!version.available) {
    throw new Error('Media engine is not available');
  }

  return new Promise<{
    id: string;
    title: string;
    duration: number;
    durationString: string;
    thumbnail: string;
    webpageUrl: string;
    formats: Array<{
      formatId: string;
      height: number | null;
      width: number | null;
      ext: string;
      filesize: number;
      filesizeApprox: number;
      vcodec: string;
      acodec: string;
      formatNote: string | null;
      tbr: number | null;
      abr: number | null;
      vbr: number | null;
      fps: number | null;
    }>;
  }>((resolve, reject) => {
    const args = ['--dump-json', '--skip-download', '--no-playlist', url];
    const child = spawn(ytDlpBin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', error => reject(new Error(error.message)));
    child.on('exit', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Media engine exited with code ${code}`));
        return;
      }
      try {
        const raw = JSON.parse(stdout.trim().split(/\r?\n/)[0]);
        const formats = (raw.formats || []).map((f: Record<string, unknown>) => ({
          formatId: String(f.format_id || ''),
          height: typeof f.height === 'number' ? f.height : null,
          width: typeof f.width === 'number' ? f.width : null,
          ext: String(f.ext || ''),
          filesize: typeof f.filesize === 'number' ? f.filesize : 0,
          filesizeApprox: typeof f.filesize_approx === 'number' ? f.filesize_approx : 0,
          vcodec: String(f.vcodec || ''),
          acodec: String(f.acodec || ''),
          formatNote: typeof f.format_note === 'string' ? f.format_note : null,
          tbr: typeof f.tbr === 'number' ? f.tbr : null,
          abr: typeof f.abr === 'number' ? f.abr : null,
          vbr: typeof f.vbr === 'number' ? f.vbr : null,
          fps: typeof f.fps === 'number' ? f.fps : null,
        }));
        resolve({
          id: String(raw.id || ''),
          title: String(raw.title || ''),
          duration: typeof raw.duration === 'number' ? raw.duration : 0,
          durationString: String(raw.duration_string || ''),
          thumbnail: String(raw.thumbnail || ''),
          webpageUrl: String(raw.webpage_url || url),
          formats,
        });
      } catch (e) {
        reject(new Error(`Failed to parse media output: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}

function resolveTarget(savePath: string | undefined, fallbackName: string): { dir: string; fileName: string } {
  if (!savePath) {
    return { dir: path.join(os.homedir(), 'Downloads', 'NOVA'), fileName: fallbackName };
  }

  const ext = path.extname(savePath);
  if (!ext) {
    return { dir: savePath, fileName: fallbackName };
  }
  return { dir: path.dirname(savePath), fileName: path.basename(savePath) };
}

function normalizeSaveDirectory(savePath: string | undefined): string {
  if (!savePath) {
    return path.join(os.homedir(), 'Downloads', 'NOVA', 'Media');
  }
  return path.extname(savePath) ? path.dirname(savePath) : savePath;
}

function normalizeConnections(value: number | undefined): number {
  if (!value || value <= 0) return 16;
  return Math.max(1, Math.min(32, Math.round(value)));
}

function mapAriaStatus(status: Aria2Status['status']): DownloadStatus {
  if (status === 'active') return 'downloading';
  if (status === 'complete') return 'completed';
  if (status === 'paused') return 'paused';
  if (status === 'waiting') return 'queued';
  return 'error';
}

function buildSegments(count: number, totalBytes: number, downloadedBytes: number, active: boolean, speed: number): NovaTask['segments'] {
  const segmentCount = Math.max(1, Math.min(32, count || 1));
  const safeTotal = Math.max(totalBytes, downloadedBytes, 1);
  const perSegment = Math.ceil(safeTotal / segmentCount);
  let remaining = downloadedBytes;

  return Array.from({ length: segmentCount }, (_, index) => {
    const segmentDownloaded = Math.max(0, Math.min(perSegment, remaining));
    remaining -= segmentDownloaded;
    const progress = Math.round((segmentDownloaded / perSegment) * 100);
    return {
      id: index + 1,
      progress,
      downloadedBytes: segmentDownloaded,
      totalBytes: perSegment,
      active: active && progress > 0 && progress < 100,
      speed: active ? Math.round(speed / segmentCount) : 0
    };
  });
}

function inferFileType(nameOrUrl: string): FileType {
  const ext = path.extname(nameOrUrl.split('?')[0]).replace('.', '').toLowerCase();
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub'].includes(ext)) return 'document';
  if (['exe', 'msi', 'apk', 'dmg', 'pkg', 'bat', 'sh'].includes(ext)) return 'program';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'iso', 'cab'].includes(ext)) return 'compressed';
  if (['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'ts'].includes(ext)) return 'video';
  if (['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma'].includes(ext)) return 'audio';
  return 'other';
}

function fileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const candidate = decodeURIComponent(path.basename(parsed.pathname));
    return candidate || 'download.bin';
  } catch {
    return 'download.bin';
  }
}

function fileNameFromContentDisposition(value: string): string {
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return utf8Match[1].trim().replace(/^"|"$/g, '');
    }
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1]?.trim() || '';
}

function sanitizeFileName(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'download.bin';
}

function parseByteAmount(input: string): number {
  const match = input.trim().match(/^([0-9.]+)\s*([KMGTP]?i?B)$/i);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const power = unit.startsWith('K') ? 1 : unit.startsWith('M') ? 2 : unit.startsWith('G') ? 3 : unit.startsWith('T') ? 4 : unit.startsWith('P') ? 5 : 0;
  return Math.round(value * (1024 ** power));
}

function parseEta(input: string): number {
  const parts = input.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function commandVersion(command: string, args: string[], timeoutMs = 8000): Promise<{ available: boolean; version: string; error?: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true });
    let output = '';
    let errorOutput = '';
    let settled = false;

    const finish = (result: { available: boolean; version: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ available: false, version: '', error: 'engine version check timed out' });
    }, timeoutMs);

    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errorOutput += String(chunk); });
    child.on('error', error => {
      finish({ available: false, version: '', error: error.message });
    });
    child.on('exit', code => {
      if (code === 0) {
        finish({ available: true, version: firstVersionLine(output || errorOutput) });
      } else {
        finish({ available: false, version: '', error: firstVersionLine(errorOutput || output) || `exit ${code}` });
      }
    });
  });
}

function firstVersionLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
}

function sanitizeEngineNames(message: string): string {
  return message
    .replace(/yt[-_ ]?dlp(?:\.exe)?/gi, 'media engine')
    .replace(/youtube-dl(?:\.exe)?/gi, 'media engine')
    .replace(/aria2c?(?:\.exe)?/gi, 'direct download engine');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return sanitizeEngineNames(error instanceof Error ? error.message : String(error));
}
