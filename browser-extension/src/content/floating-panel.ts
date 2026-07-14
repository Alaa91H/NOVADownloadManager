import browser from 'webextension-polyfill';

const HOST_ID = 'nova-media-panel-host';
const CHECK_INTERVAL_MS = 2000;
const PANEL_OPACITY_DEFAULT = 0.35;
const PANEL_OPACITY_HOVER = 1;

let panelHost: ShadowRoot | null = null;
let panelEl: HTMLDivElement | null = null;
let trackedElements = new WeakSet<Element>();
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let currentCandidates: PanelCandidate[] = [];

type PanelCandidate = {
  id: string;
  url: string;
  quality?: string;
  sizeBytes?: number;
  codec?: string;
  format?: string;
  type: 'video' | 'audio';
  width?: number;
  height?: number;
  durationSec?: number;
};

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function formatDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatResolution(w?: number, h?: number): string {
  if (!w || !h) return '';
  if (h >= 2160) return '4K';
  if (h >= 1440) return '1440p';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  if (h >= 360) return '360p';
  if (h >= 240) return '240p';
  return `${h}p`;
}

function getMediaInfo(el: HTMLVideoElement | HTMLAudioElement): PanelCandidate | null {
  const src = el.currentSrc || el.src;
  if (!src || src.startsWith('blob:') || src.startsWith('data:')) return null;
  const isVideo = el instanceof HTMLVideoElement;
  const w = isVideo ? (el as HTMLVideoElement).videoWidth : undefined;
  const h = isVideo ? (el as HTMLVideoElement).videoHeight : undefined;
  const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined;
  const fmt = extractFormat(src);
  return {
    id: `media-${btoa(src).slice(0, 20)}`,
    url: src,
    quality: formatResolution(w, h),
    type: isVideo ? 'video' : 'audio',
    width: w,
    height: h,
    durationSec: dur,
    format: fmt,
  };
}

function extractFormat(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop()?.split('?')[0]?.toLowerCase();
    if (ext) return ext;
  } catch {}
  if (url.includes('.m3u8') || url.includes('mime=audio') || url.includes('mime=video')) return 'mp4';
  return '';
}

function collectFromPlayerConfig(): PanelCandidate[] {
  const results: PanelCandidate[] = [];
  try {
    const w = window as unknown as Record<string, unknown>;
    const playerResponse = (w.ytInitialPlayerResponse ?? w.ytcfg) as Record<string, unknown> | undefined;
    if (!playerResponse) return results;
    const streamingData = (playerResponse as Record<string, unknown>).streamingData as Record<string, unknown> | undefined;
    if (!streamingData) return results;
    const formats = [
      ...((streamingData.formats ?? []) as Array<Record<string, unknown>>),
      ...((streamingData.adaptiveFormats ?? []) as Array<Record<string, unknown>>),
    ];
    for (const fmt of formats) {
      const url = fmt.url as string | undefined;
      if (!url) continue;
      const mime = (fmt.mimeType as string) || '';
      const isAudio = mime.startsWith('audio');
      const w2 = fmt.width as number | undefined;
      const h2 = fmt.height as number | undefined;
      const contentLength = fmt.contentLength ? parseInt(fmt.contentLength as string, 10) : undefined;
      const codecMatch = mime.match(/codecs="([^"]+)"/);
      results.push({
        id: `cfg-${btoa(url).slice(0, 20)}`,
        url,
        quality: fmt.qualityLabel as string || formatResolution(w2, h2),
        sizeBytes: Number.isFinite(contentLength) ? contentLength : undefined,
        codec: codecMatch?.[1],
        format: mime.split(';')[0]?.split('/')[1] || 'mp4',
        type: isAudio ? 'audio' : 'video',
        width: w2,
        height: h2,
      });
    }
  } catch {}
  return results;
}

function ensurePanelHost(): ShadowRoot {
  if (panelHost && panelHost.host.isConnected) return panelHost;
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(host);
  panelHost = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    .nova-panel {
      position: fixed;
      top: 8px;
      right: 8px;
      min-width: 280px;
      max-width: 420px;
      max-height: 60vh;
      background: rgba(10, 10, 15, 0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      color: #e4e4e7;
      overflow: hidden;
      pointer-events: auto;
      transition: opacity 0.3s ease, transform 0.3s ease;
      opacity: ${PANEL_OPACITY_DEFAULT};
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      user-select: none;
    }
    .nova-panel:hover, .nova-panel.nova-panel-active {
      opacity: ${PANEL_OPACITY_HOVER};
    }
    .nova-panel.nova-panel-expanded {
      opacity: ${PANEL_OPACITY_HOVER};
    }
    .nova-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      cursor: move;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
    }
    .nova-header-badge {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .nova-header-icon {
      width: 16px;
      height: 16px;
      fill: #3b82f6;
    }
    .nova-header-title {
      font-size: 11px;
      font-weight: 600;
      color: #a1a1aa;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .nova-header-count {
      background: #3b82f6;
      color: #fff;
      border-radius: 10px;
      padding: 1px 7px;
      font-size: 10px;
      font-weight: 700;
      min-width: 18px;
      text-align: center;
    }
    .nova-header-toggle {
      background: none;
      border: none;
      color: #71717a;
      cursor: pointer;
      padding: 2px;
      font-size: 14px;
      line-height: 1;
    }
    .nova-header-toggle:hover { color: #e4e4e7; }
    .nova-list {
      overflow-y: auto;
      max-height: 50vh;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.1) transparent;
    }
    .nova-list::-webkit-scrollbar { width: 4px; }
    .nova-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
    .nova-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      cursor: pointer;
      transition: background 0.15s;
    }
    .nova-item:hover { background: rgba(59, 130, 246, 0.1); }
    .nova-item:last-child { border-bottom: none; }
    .nova-item-icon {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      fill: #3b82f6;
    }
    .nova-item-icon.nova-audio { fill: #a855f7; }
    .nova-item-info {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: nowrap;
      overflow: hidden;
    }
    .nova-item-tag {
      display: inline-flex;
      align-items: center;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      white-space: nowrap;
      background: rgba(59, 130, 246, 0.15);
      color: #93c5fd;
    }
    .nova-item-tag.nova-audio { background: rgba(168, 85, 247, 0.15); color: #c4b5fd; }
    .nova-item-tag.nova-size { background: rgba(255,255,255,0.06); color: #a1a1aa; }
    .nova-item-tag.nova-dur { background: rgba(255,255,255,0.06); color: #a1a1aa; }
    .nova-item-tag.nova-codec { background: rgba(255,255,255,0.04); color: #71717a; font-size: 9px; }
    .nova-item-sep { color: #3f3f46; font-size: 9px; flex-shrink: 0; }
    .nova-item-dl {
      flex-shrink: 0;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      background: #3b82f6;
      color: #fff;
      border: none;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.15s;
    }
    .nova-item-dl:hover { background: #2563eb; }
    .nova-empty {
      padding: 16px 12px;
      text-align: center;
      color: #52525b;
      font-size: 11px;
    }
    .nova-actions {
      display: flex;
      gap: 6px;
      padding: 8px 12px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .nova-btn {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 5px;
      background: rgba(255,255,255,0.05);
      color: #e4e4e7;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
      text-align: center;
    }
    .nova-btn:hover { background: rgba(255,255,255,0.1); }
    .nova-btn-primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
    .nova-btn-primary:hover { background: #2563eb; }
  `;
  panelHost.appendChild(style);

  panelEl = document.createElement('div');
  panelEl.className = 'nova-panel';
  panelHost.appendChild(panelEl);

  setupDrag(panelEl);
  renderPanel();

  return panelHost;
}

function setupDrag(el: HTMLDivElement): void {
  const header = el.querySelector('.nova-header') as HTMLElement | null;
  if (!header) return;

  header.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.nova-header-toggle')) return;
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
  });

  document.addEventListener('mouseup', () => {
    if (isDragging && panelEl) {
      isDragging = false;
      panelEl.style.transition = '';
    }
  });
}

function positionPanelAtVideo(): void {
  if (!panelEl || isDragging) return;
  const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of videos) {
    const rect = v.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 60) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) { bestArea = area; best = v; }
  }
  if (!best) return;
  const r = best.getBoundingClientRect();
  panelEl.style.left = '';
  panelEl.style.bottom = '';
  panelEl.style.top = `${Math.max(4, r.top + 8)}px`;
  panelEl.style.right = `${Math.max(4, window.innerWidth - r.right + 8)}px`;
}

function renderPanel(): void {
  if (!panelEl) return;
  const isExpanded = panelEl.classList.contains('nova-panel-expanded');
  const items = isExpanded ? currentCandidates : currentCandidates.slice(0, 3);

  let html = `
    <div class="nova-header">
      <div class="nova-header-badge">
        <svg class="nova-header-icon" viewBox="0 0 16 16"><path d="M4 3a2 2 0 00-2 2v6a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2H4zm2.5 5.5L11 8l-4.5 2.5V8.5z"/></svg>
        <span class="nova-header-title">Media</span>
        ${currentCandidates.length > 0 ? `<span class="nova-header-count">${currentCandidates.length}</span>` : ''}
      </div>
      <button class="nova-header-toggle" data-action="toggle">${isExpanded ? '&#9650;' : '&#9660;'}</button>
    </div>
  `;

  if (items.length === 0) {
    html += `<div class="nova-empty">Scanning for media...</div>`;
  } else {
    html += '<div class="nova-list">';
    for (const c of items) {
      const icon = c.type === 'audio'
        ? '<svg class="nova-item-icon nova-audio" viewBox="0 0 16 16"><path d="M6 3v7.5a2.5 2.5 0 102 2.45V6.5h3V3H6z"/></svg>'
        : '<svg class="nova-item-icon" viewBox="0 0 16 16"><path d="M4 3a2 2 0 00-2 2v6a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2H4zm2.5 5.5L11 8l-4.5 2.5V8.5z"/></svg>';
      const tags: string[] = [];
      if (c.quality) tags.push(`<span class="nova-item-tag${c.type === 'audio' ? ' nova-audio' : ''}">${esc(c.quality)}</span>`);
      if (c.codec) tags.push(`<span class="nova-item-tag nova-codec">${esc(c.codec.split('.')[0] ?? c.codec)}</span>`);
      if (c.sizeBytes && c.sizeBytes > 0) tags.push(`<span class="nova-item-tag nova-size">${esc(formatSize(c.sizeBytes))}</span>`);
      if (c.durationSec) tags.push(`<span class="nova-item-tag nova-dur">${esc(formatDuration(c.durationSec))}</span>`);
      if (c.format) tags.push(`<span class="nova-item-tag nova-size">${esc(c.format.toUpperCase())}</span>`);

      html += `
        <div class="nova-item" data-action="send" data-id="${esc(c.id)}">
          ${icon}
          <div class="nova-item-info">${tags.join('<span class="nova-item-sep">&middot;</span>')}</div>
          <button class="nova-item-dl" data-action="send" data-id="${esc(c.id)}" title="Send">&#8595;</button>
        </div>
      `;
    }
    html += '</div>';
  }

  if (currentCandidates.length > 0) {
    html += `
      <div class="nova-actions">
        <button class="nova-btn nova-btn-primary" data-action="send-all">Send All</button>
        <button class="nova-btn" data-action="scan">Scan</button>
      </div>
    `;
  }

  panelEl.innerHTML = html;

  panelEl.querySelectorAll('[data-action="toggle"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      panelEl?.classList.toggle('nova-panel-expanded');
      renderPanel();
    });
  });

  panelEl.querySelectorAll('[data-action="send"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (el as HTMLElement).dataset.id;
      if (id) sendCandidate(id);
    });
  });

  const sendAllBtn = panelEl.querySelector('[data-action="send-all"]');
  if (sendAllBtn) {
    sendAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendAllCandidates();
    });
  }

  const scanBtn = panelEl.querySelector('[data-action="scan"]');
  if (scanBtn) {
    scanBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      scanCurrentTab();
    });
  }
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function panelCandidateToCandidate(c: PanelCandidate): Record<string, unknown> {
  return {
    id: c.id,
    url: c.url,
    pageUrl: location.href,
    source: 'media-element' as const,
    mediaType: (c.type === 'audio' ? 'audio' : 'video') as 'audio' | 'video',
    mimeType: c.codec ? `${c.type}/${c.codec}` : undefined,
    sizeBytes: c.sizeBytes,
    width: c.width,
    height: c.height,
    durationSec: c.durationSec,
    bitrate: undefined,
    confidence: 85,
  };
}

function sendCandidate(id: string): void {
  const c = currentCandidates.find((x) => x.id === id);
  if (!c) return;
  void browser.runtime.sendMessage({ type: 'SEND_CANDIDATE', candidate: panelCandidateToCandidate(c) }).catch(() => {
    void browser.runtime.sendMessage({ type: 'CAPTURE_DOWNLOAD', payload: { url: c.url, source: 'floating-panel' } }).catch(() => {});
  });
}

function sendAllCandidates(): void {
  if (currentCandidates.length > 0) {
    const candidates = currentCandidates.map(panelCandidateToCandidate);
    void browser.runtime.sendMessage({ type: 'SEND_BATCH', candidates }).catch(() => {});
  }
}

function scanCurrentTab(): void {
  void browser.runtime.sendMessage({ type: 'SCAN_PAGE', userActivated: true }).catch(() => {});
}

function updateCandidates(newCandidates: PanelCandidate[]): void {
  const existingIds = new Set(currentCandidates.map((c) => c.id));
  for (const nc of newCandidates) {
    if (!existingIds.has(nc.id)) {
      currentCandidates.push(nc);
    } else {
      const existing = currentCandidates.find((c) => c.id === nc.id);
      if (existing) {
        if (nc.sizeBytes && !existing.sizeBytes) existing.sizeBytes = nc.sizeBytes;
        if (nc.codec && !existing.codec) existing.codec = nc.codec;
        if (nc.quality && !existing.quality) existing.quality = nc.quality;
      }
    }
  }
  currentCandidates.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'video' ? -1 : 1;
    return (b.height ?? 0) - (a.height ?? 0);
  });
  if (panelEl) {
    renderPanel();
    positionPanelAtVideo();
  }
}

function scanMediaElements(): void {
  const mediaEls = document.querySelectorAll('video, audio');
  const candidates: PanelCandidate[] = [];
  for (const el of Array.from(mediaEls)) {
    if (trackedElements.has(el)) continue;
    trackedElements.add(el);
    const info = getMediaInfo(el as HTMLVideoElement | HTMLAudioElement);
    if (info) candidates.push(info);
    if (el instanceof HTMLVideoElement) {
      el.addEventListener('loadedmetadata', () => {
        const updated = getMediaInfo(el);
        if (updated) updateCandidates([updated]);
      }, { once: true });
    }
  }
  const playerCandidates = collectFromPlayerConfig();
  candidates.push(...playerCandidates);
  if (candidates.length > 0) updateCandidates(candidates);
}

function listenForPageTapEvents(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'nova-page-tap-v1' || data.type !== 'NOVA_PAGE_TAP_CANDIDATE') return;
    if (!data.url) return;
    const isAudio = data.mediaHint === 'audio' || data.mimeHint?.startsWith('audio');
    const candidate: PanelCandidate = {
      id: `tap-${btoa(data.url).slice(0, 20)}`,
      url: data.url,
      quality: data.qualityLabel || (data.width && data.height ? formatResolution(data.width, data.height) : undefined),
      sizeBytes: data.sizeBytes,
      type: isAudio ? 'audio' : 'video',
      width: data.width,
      height: data.height,
      durationSec: data.durationSec,
    };
    updateCandidates([candidate]);
  });
}

function init(): void {
  ensurePanelHost();
  scanMediaElements();
  listenForPageTapEvents();
  positionPanelAtVideo();
  setInterval(scanMediaElements, CHECK_INTERVAL_MS);

  window.addEventListener('scroll', () => positionPanelAtVideo(), { passive: true });
  window.addEventListener('resize', () => positionPanelAtVideo(), { passive: true });

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof HTMLElement && (node.tagName === 'VIDEO' || node.tagName === 'AUDIO' || node.querySelector?.('video, audio'))) {
          scanMediaElements();
          positionPanelAtVideo();
        }
      }
    }
  });
  observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
