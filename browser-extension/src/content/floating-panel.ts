import browser from 'webextension-polyfill';

const HOST_ID = 'nova-media-panel-host';
const CHECK_INTERVAL_MS = 3000;

let panelHost: ShadowRoot | null = null;
let panelEl: HTMLDivElement | null = null;
let panelVisible = false;
let dropdownVisible = false;
let bridgeConnected = false;
let probing = false;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let savedPosition: { top: string; right: string; left: string; bottom: string } | null = null;
let toastEl: HTMLDivElement | null = null;
let probeData: YtdlpProbeData | null = null;

interface YtdlpFormat {
  url: string;
  width?: number;
  height?: number;
  label?: string;
  formatId?: string;
  container?: string;
  fps?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  estimatedSizeBytes?: number;
  codecs?: string;
  ext?: string;
  format?: string;
  formatNote?: string;
  resolution?: string;
  vcodec?: string;
  acodec?: string;
  bandwidth?: number;
  tbr?: number;
}

interface YtdlpProbeData {
  title?: string;
  duration?: number;
  thumbnail?: string;
  formats: YtdlpFormat[];
  uploader?: string;
  webpageUrl?: string;
}

function fmtBytes(b?: number): string {
  if (!b || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

function fmtDur(s?: number): string {
  if (!s || !Number.isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function qLabel(f: YtdlpFormat): string {
  if (f.label) return f.label;
  if (f.height) return `${f.height}p${f.fps && f.fps > 30 ? ` ${f.fps}` : ''}`;
  if (f.formatNote) return f.formatNote;
  return f.formatId || '?';
}

function codecStr(f: YtdlpFormat): string {
  const p: string[] = [];
  if (f.vcodec && f.vcodec !== 'none') p.push(f.vcodec.split('.')[0] ?? f.vcodec);
  if (f.acodec && f.acodec !== 'none') p.push(f.acodec.split('.')[0] ?? f.acodec);
  return p.join('+') || '';
}

function resStr(f: YtdlpFormat): string {
  if (f.width && f.height) return `${f.width}\u00d7${f.height}`;
  return f.resolution || '\u2014';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function qualityColor(h?: number): string {
  if (!h) return '#a1a1aa';
  if (h >= 2160) return '#a855f7';
  if (h >= 1440) return '#3b82f6';
  if (h >= 720) return '#22c55e';
  if (h >= 480) return '#f59e0b';
  return '#ef4444';
}

// --- Toast ---

function showToast(msg: string, isError = false): void {
  if (!panelHost) return;
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'nova-toast';
    panelHost.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.classList.add('show');
  setTimeout(() => toastEl?.classList.remove('show'), 2200);
}

// --- Bridge state ---

async function checkBridge(): Promise<void> {
  try {
    const s = await browser.runtime.sendMessage({ type: 'GET_BRIDGE_STATE' }) as { canSend?: boolean } | undefined;
    const prev = bridgeConnected;
    bridgeConnected = Boolean(s?.canSend);
    if (prev !== bridgeConnected && panelVisible) render();
  } catch {
    bridgeConnected = false;
  }
}

// --- yt-dlp probe ---

async function doProbe(): Promise<void> {
  if (probing) return;
  if (!bridgeConnected) {
    showToast('NOVA desktop not connected', true);
    return;
  }
  probing = true;
  render();
  try {
    const r = await browser.runtime.sendMessage({ type: 'PROBE_YTDLP', url: location.href }) as YtdlpProbeData | null;
    if (r?.formats?.length) {
      probeData = r;
      dropdownVisible = true;
      render();
    } else {
      showToast('No downloadable formats found', true);
    }
  } catch {
    showToast('Failed to fetch video info', true);
  } finally {
    probing = false;
    render();
  }
}

// --- Send to NOVA ---

function sendFormat(f: YtdlpFormat): void {
  if (!bridgeConnected) { showToast('NOVA desktop not connected', true); return; }
  const candidate = {
    id: `ytdlp-${f.formatId || btoa(f.url).slice(0, 16)}`,
    url: f.url,
    pageUrl: location.href,
    source: 'ytdlp-probe' as const,
    mediaType: (f.hasVideo !== false && f.height ? 'video' : 'audio') as 'video' | 'audio',
    sizeBytes: f.estimatedSizeBytes,
    width: f.width,
    height: f.height,
    confidence: 95,
  };
  void browser.runtime.sendMessage({ type: 'SEND_CANDIDATE', candidate })
    .then(() => showToast(`Sent ${qLabel(f)} to NOVA`))
    .catch(() => showToast('Failed to send to NOVA', true));
}

function sendBest(): void {
  if (!probeData?.formats?.length) return;
  const videos = probeData.formats
    .filter(f => f.hasVideo !== false && f.height)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  const bestVideo = videos[0];
  if (bestVideo) { sendFormat(bestVideo); return; }
  const audios = probeData.formats
    .filter(f => f.hasAudio !== false && !f.height)
    .sort((a, b) => (b.bandwidth ?? b.tbr ?? 0) - (a.bandwidth ?? a.tbr ?? 0));
  const bestAudio = audios[0];
  if (bestAudio) sendFormat(bestAudio);
}

function sortFormats(fmts: YtdlpFormat[]): YtdlpFormat[] {
  return [...fmts].sort((a, b) => {
    const aV = a.hasVideo !== false && a.height ? 1 : 0;
    const bV = b.hasVideo !== false && b.height ? 1 : 0;
    if (aV !== bV) return bV - aV;
    if (a.height !== b.height) return (b.height ?? 0) - (a.height ?? 0);
    return (b.bandwidth ?? b.tbr ?? 0) - (a.bandwidth ?? a.tbr ?? 0);
  });
}

// --- Shadow DOM ---

function ensurePanel(): ShadowRoot {
  if (panelHost && panelHost.host.isConnected) return panelHost;
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(host);
  panelHost = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { margin:0; padding:0; box-sizing:border-box; }
    .nova-p {
      position:fixed; top:8px; right:8px;
      background:rgba(8,8,14,1); border:1px solid rgba(255,255,255,0.10);
      border-radius:10px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      font-size:11px; color:#e4e4e7; pointer-events:auto; user-select:none;
      opacity:0; transition:opacity .2s; z-index:2147483647;
    }
    .nova-bar { display:flex; align-items:center; gap:4px; padding:5px 6px; cursor:move; }
    .nova-dl {
      display:inline-flex; align-items:center; gap:4px; padding:5px 10px;
      border-radius:6px; border:1px solid rgba(59,130,246,0.4);
      background:rgba(59,130,246,0.15); color:#93c5fd; font-size:11px;
      font-weight:600; cursor:pointer; transition:all .15s; white-space:nowrap;
    }
    .nova-dl:hover { background:rgba(59,130,246,0.3); border-color:#3b82f6; color:#fff; }
    .nova-dl:disabled { opacity:.5; cursor:wait; pointer-events:none; }
    .nova-dl svg { width:13px; height:13px; }
    .nova-x {
      display:inline-flex; align-items:center; justify-content:center;
      width:20px; height:20px; border-radius:4px; border:1px solid rgba(255,255,255,0.08);
      background:rgba(255,255,255,0.04); color:#71717a; cursor:pointer; transition:all .15s;
      padding:0; font-size:11px; line-height:1; flex-shrink:0;
    }
    .nova-x:hover { color:#ef4444; background:rgba(239,68,68,0.1); border-color:rgba(239,68,68,0.3); }
    .nova-x svg { width:11px; height:11px; }
    .nova-spin {
      display:inline-block; width:12px; height:12px; border:2px solid rgba(59,130,246,0.3);
      border-top-color:#3b82f6; border-radius:50%; animation:nspin .6s linear infinite;
    }
    @keyframes nspin { to { transform:rotate(360deg); } }
    .nova-dd {
      position:absolute; top:100%; left:0; right:0; max-height:55vh; overflow-y:auto;
      background:rgba(12,12,20,1); border-top:1px solid rgba(255,255,255,0.06);
    }
    .nova-dd::-webkit-scrollbar { width:4px; }
    .nova-dd::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.12); border-radius:2px; }
    .nova-info {
      display:flex; gap:8px; padding:8px 10px;
      border-bottom:1px solid rgba(255,255,255,0.04); background:rgba(255,255,255,0.015);
    }
    .nova-thumb { width:72px; height:40px; border-radius:4px; object-fit:cover; flex-shrink:0; background:rgba(255,255,255,0.05); }
    .nova-meta { min-width:0; display:flex; flex-direction:column; gap:2px; }
    .nova-title {
      font-size:11px; font-weight:600; line-height:1.3; color:#fafafa; overflow:hidden;
      display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
    }
    .nova-sub { font-size:9px; color:#71717a; display:flex; gap:8px; align-items:center; }
    .nova-thdr {
      display:grid; grid-template-columns:100px 80px 70px 40px 60px 70px;
      font-size:8px; text-transform:uppercase; letter-spacing:.04em; color:#52525b;
      font-weight:500; padding:3px 10px; border-bottom:1px solid rgba(255,255,255,0.06);
      background:rgba(255,255,255,0.015);
    }
    .nova-thdr span:last-child { text-align:center; }
    .nova-row {
      display:grid; grid-template-columns:100px 80px 70px 40px 60px 70px;
      align-items:center; padding:4px 10px; font-size:10px;
      border-bottom:1px solid rgba(255,255,255,0.03); transition:background .12s;
    }
    .nova-row:hover { background:rgba(59,130,246,0.06); }
    .nova-row:last-child { border-bottom:none; }
    .nova-q {
      display:inline-flex; align-items:center; padding:2px 6px;
      border-radius:4px; font-size:9px; font-weight:700; line-height:1.2;
    }
    .nova-cdr { font-size:9px; color:#c084fc; font-weight:500; }
    .nova-sbtn {
      font-size:9px; font-weight:600; padding:3px 8px; border-radius:4px;
      border:1px solid rgba(59,130,246,0.4); background:rgba(59,130,246,0.15);
      color:#93c5fd; cursor:pointer; transition:all .15s; text-align:center;
    }
    .nova-sbtn:hover { background:rgba(59,130,246,0.3); border-color:#3b82f6; color:#fff; }
    .nova-foot {
      display:flex; gap:6px; padding:8px 10px;
      border-top:1px solid rgba(255,255,255,0.06); background:rgba(255,255,255,0.015);
    }
    .nova-best {
      flex:1; padding:6px 10px; border:1px solid rgba(59,130,246,0.4);
      border-radius:5px; font-size:10px; font-weight:600; cursor:pointer; text-align:center;
      background:#3b82f6; color:#fff; transition:background .15s;
    }
    .nova-best:hover { background:#2563eb; }
    .nova-toast {
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(20px);
      background:rgba(8,8,14,1); border:1px solid rgba(34,197,94,0.4); border-radius:8px;
      padding:8px 16px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      font-size:11px; font-weight:600; color:#4ade80; z-index:2147483647;
      pointer-events:none; opacity:0; transition:opacity .3s,transform .3s; white-space:nowrap;
    }
    .nova-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
    .nova-toast.error { border-color:rgba(239,68,68,0.4); color:#ef4444; }
  `;
  panelHost.appendChild(style);

  panelEl = document.createElement('div');
  panelEl.className = 'nova-p';
  panelHost.appendChild(panelEl);
  setupDrag(panelEl);
  render();
  return panelHost;
}

function setupDrag(el: HTMLDivElement): void {
  el.addEventListener('mousedown', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('.nova-dl, .nova-x, .nova-sbtn, .nova-best, button')) return;
    isDragging = true;
    const rect = el.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    el.style.transition = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging || !panelEl) return;
    const x = Math.max(0, Math.min(window.innerWidth - 50, e.clientX - dragOffsetX));
    const y = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - dragOffsetY));
    panelEl.style.right = 'auto';
    panelEl.style.bottom = 'auto';
    panelEl.style.left = `${x}px`;
    panelEl.style.top = `${y}px`;
    savedPosition = { top: panelEl.style.top, right: panelEl.style.right, left: panelEl.style.left, bottom: panelEl.style.bottom };
  });
  document.addEventListener('mouseup', () => {
    if (isDragging && panelEl) { isDragging = false; panelEl.style.transition = ''; }
  });
}

function positionAtVideo(): void {
  if (!panelEl || isDragging || savedPosition) return;
  const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of videos) {
    const r = v.getBoundingClientRect();
    if (r.width < 100 || r.height < 60) continue;
    const a = r.width * r.height;
    if (a > bestArea) { bestArea = a; best = v; }
  }
  if (!best) return;
  const r = best.getBoundingClientRect();
  panelEl.style.left = '';
  panelEl.style.bottom = '';
  panelEl.style.top = `${Math.max(4, r.top + 8)}px`;
  panelEl.style.right = `${Math.max(4, window.innerWidth - r.right + 8)}px`;
}

// --- Render ---

function render(): void {
  if (!panelEl) return;
  if (!panelVisible) {
    panelEl.style.opacity = '0';
    panelEl.style.pointerEvents = 'none';
    return;
  }
  panelEl.style.opacity = '1';
  panelEl.style.pointerEvents = 'auto';

  let html = '<div class="nova-bar" data-drag="header">';
  html += `<button class="nova-dl" data-action="download"${probing ? ' disabled' : ''}>`;
  if (probing) {
    html += '<span class="nova-spin"></span> Probing...';
  } else {
    html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download';
  }
  html += '</button>';
  html += '<button class="nova-x" data-action="close" title="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
  html += '</div>';

  if (dropdownVisible && probeData) {
    const fmts = sortFormats(probeData.formats);
    html += '<div class="nova-dd">';
    if (probeData.title || probeData.thumbnail) {
      html += '<div class="nova-info">';
      if (probeData.thumbnail) html += `<img class="nova-thumb" src="${esc(probeData.thumbnail)}" alt="" />`;
      html += '<div class="nova-meta">';
      if (probeData.title) html += `<div class="nova-title">${esc(probeData.title)}</div>`;
      html += '<div class="nova-sub">';
      html += `<span>${fmts.length} formats</span>`;
      if (probeData.duration) html += `<span>${fmtDur(probeData.duration)}</span>`;
      if (probeData.uploader) html += `<span>${esc(probeData.uploader)}</span>`;
      html += '</div></div></div>';
    }
    html += '<div class="nova-thdr"><span>Quality</span><span>Resolution</span><span>Codec</span><span>FPS</span><span>Size</span><span></span></div>';
    for (const f of fmts) {
      const color = qualityColor(f.height);
      const bg = `${color}22`;
      const border = `${color}44`;
      html += '<div class="nova-row">';
      html += `<span><span class="nova-q" style="background:${bg};color:${color};border:1px solid ${border}">${esc(qLabel(f))}</span></span>`;
      html += `<span style="color:#a1a1aa">${resStr(f)}</span>`;
      html += `<span class="nova-cdr">${esc(codecStr(f))}</span>`;
      html += `<span style="color:#a1a1aa">${f.fps ? `${f.fps}` : '\u2014'}</span>`;
      html += `<span style="color:#a1a1aa;font-variant-numeric:tabular-nums">${fmtBytes(f.estimatedSizeBytes) || '\u2014'}</span>`;
      html += `<span style="text-align:center"><button class="nova-sbtn" data-action="send" data-fid="${esc(f.formatId || '')}">Download</button></span>`;
      html += '</div>';
    }
    html += '<div class="nova-foot"><button class="nova-best" data-action="send-best">Best Quality</button></div>';
    html += '</div>';
  }

  panelEl.innerHTML = html;
  bindEvents();
}

function bindEvents(): void {
  panelEl?.querySelector('[data-action="download"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!dropdownVisible) doProbe();
    else { dropdownVisible = false; render(); }
  });
  panelEl?.querySelector('[data-action="close"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    panelVisible = false;
    dropdownVisible = false;
    if (panelEl) {
      panelEl.style.opacity = '0';
      panelEl.style.pointerEvents = 'none';
    }
  });
  panelEl?.querySelectorAll('[data-action="send"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const fid = (el as HTMLElement).dataset.fid;
      if (!fid || !probeData) return;
      const f = probeData.formats.find(x => x.formatId === fid);
      if (f) sendFormat(f);
    });
  });
  panelEl?.querySelector('[data-action="send-best"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    sendBest();
  });
}

// --- Media detection ---

let mediaDetected = false;

function scanMedia(): void {
  const found = document.querySelectorAll('video, audio').length > 0;
  if (found && !mediaDetected) {
    mediaDetected = true;
    panelVisible = true;
    render();
    positionAtVideo();
  } else if (!found && mediaDetected) {
    mediaDetected = false;
    panelVisible = false;
    dropdownVisible = false;
    render();
  }
}

// --- Init ---

function init(): void {
  ensurePanel();
  checkBridge();
  scanMedia();
  setInterval(scanMedia, CHECK_INTERVAL_MS);
  setInterval(checkBridge, 5000);
  window.addEventListener('scroll', () => positionAtVideo(), { passive: true });
  window.addEventListener('resize', () => positionAtVideo(), { passive: true });
  new MutationObserver(() => scanMedia()).observe(
    document.body ?? document.documentElement,
    { childList: true, subtree: true },
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
