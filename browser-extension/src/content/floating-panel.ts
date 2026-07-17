import browser from 'webextension-polyfill';

const HOST_ID = 'nova-media-panel-host';
const CHECK_INTERVAL_MS = 2500;
const PANEL_OPACITY_DEFAULT = 1;
const PANEL_OPACITY_HOVER = 1;

let panelHost: ShadowRoot | null = null;
let panelEl: HTMLDivElement | null = null;
let trackedElements = new WeakSet<Element>();
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let currentCandidates: PanelCandidate[] = [];
let savedPosition: { top: string; right: string; left: string; bottom: string } | null = null;
let emptyScanCount = 0;
let panelVisible = false;
let panelExpanded = false;
let bridgeConnected = false;
let toastEl: HTMLDivElement | null = null;

// --- ITAG quality map (same as youtube-adapter.ts for consistency) ---
const ITAG_QUALITY: Record<number, { quality: string; fps?: number; hdr?: boolean; ext?: string }> = {
  5: { quality: '144p', ext: 'flv' }, 6: { quality: '240p', ext: 'flv' },
  18: { quality: '360p', ext: 'mp4' }, 22: { quality: '720p', ext: 'mp4' },
  35: { quality: '480p', ext: 'flv' }, 37: { quality: '1080p', ext: 'mp4' },
  38: { quality: '3072p', ext: 'mp4' }, 43: { quality: '360p', ext: 'webm' },
  44: { quality: '480p', ext: 'webm' }, 45: { quality: '720p', ext: 'webm' },
  46: { quality: '1080p', ext: 'webm' }, 91: { quality: '144p', ext: 'mp4' },
  92: { quality: '240p', ext: 'mp4' }, 93: { quality: '360p', ext: 'mp4' },
  94: { quality: '480p', ext: 'mp4' }, 95: { quality: '720p', ext: 'mp4' },
  96: { quality: '1080p', ext: 'mp4' }, 133: { quality: '240p', ext: 'mp4' },
  134: { quality: '360p', ext: 'mp4' }, 135: { quality: '480p', ext: 'mp4' },
  136: { quality: '720p', ext: 'mp4' }, 137: { quality: '1080p', ext: 'mp4' },
  138: { quality: '2160p', ext: 'mp4' }, 160: { quality: '144p', ext: 'mp4' },
  242: { quality: '240p', ext: 'webm' }, 243: { quality: '360p', ext: 'webm' },
  244: { quality: '480p', ext: 'webm' }, 247: { quality: '720p', ext: 'webm' },
  248: { quality: '1080p', ext: 'webm' }, 264: { quality: '1440p', ext: 'mp4' },
  266: { quality: '2160p', ext: 'mp4' }, 271: { quality: '1440p', ext: 'webm' },
  272: { quality: '2160p', ext: 'webm' }, 278: { quality: '144p', ext: 'webm' },
  298: { quality: '720p60', fps: 60, ext: 'mp4' },
  299: { quality: '1080p60', fps: 60, ext: 'mp4' },
  302: { quality: '720p60', fps: 60, ext: 'webm' },
  303: { quality: '1080p60', fps: 60, ext: 'webm' },
  308: { quality: '1440p60', fps: 60, ext: 'webm' },
  313: { quality: '2160p', ext: 'webm' },
  315: { quality: '2160p60', fps: 60, ext: 'webm' },
  394: { quality: '144p', ext: 'mp4' }, 395: { quality: '240p', ext: 'mp4' },
  396: { quality: '360p', ext: 'mp4' }, 397: { quality: '480p', ext: 'mp4' },
  398: { quality: '720p', ext: 'mp4' }, 399: { quality: '1080p', ext: 'mp4' },
  400: { quality: '1440p', ext: 'mp4' }, 401: { quality: '2160p', ext: 'mp4' },
  402: { quality: '4320p', ext: 'mp4' },
  571: { quality: '384kbps', ext: 'm4a' },
  597: { quality: '480p', ext: 'ts' }, 598: { quality: '720p', ext: 'ts' },
  599: { quality: '1080p', ext: 'ts' }, 600: { quality: '1440p', ext: 'ts' },
  601: { quality: '2160p', ext: 'ts' },
  602: { quality: '144p', ext: 'mp4' }, 603: { quality: '240p', ext: 'mp4' },
  604: { quality: '360p', ext: 'mp4' }, 605: { quality: '480p', ext: 'mp4' },
  606: { quality: '720p', ext: 'mp4' }, 607: { quality: '1080p', ext: 'mp4' },
  608: { quality: '1440p', ext: 'mp4' }, 609: { quality: '2160p', ext: 'mp4' },
  610: { quality: '4320p', ext: 'mp4' },
  611: { quality: '1080p60', fps: 60, ext: 'mp4' },
  612: { quality: '720p60', fps: 60, ext: 'mp4' },
  613: { quality: '2160p60', fps: 60, ext: 'mp4' },
  614: { quality: '1080p60 HDR', fps: 60, hdr: true, ext: 'mp4' },
  615: { quality: '2160p60 HDR', fps: 60, hdr: true, ext: 'mp4' },
  616: { quality: '1440p60', fps: 60, ext: 'mp4' },
  617: { quality: '1440p60 HDR', fps: 60, hdr: true, ext: 'mp4' },
  618: { quality: '1080p60 HDR', fps: 60, hdr: true, ext: 'mp4' },
  619: { quality: '2160p60 HDR', fps: 60, hdr: true, ext: 'mp4' },
  620: { quality: '4320p60', fps: 60, ext: 'mp4' },
  621: { quality: '4320p60 HDR', fps: 60, hdr: true, ext: 'mp4' },
  625: { quality: '144p', ext: 'mp4' }, 626: { quality: '240p', ext: 'mp4' },
  627: { quality: '360p', ext: 'mp4' }, 628: { quality: '480p', ext: 'mp4' },
  629: { quality: '720p', ext: 'mp4' }, 630: { quality: '1080p', ext: 'mp4' },
  631: { quality: '1440p', ext: 'mp4' }, 632: { quality: '2160p', ext: 'mp4' },
  643: { quality: '144p', ext: 'mp4' }, 644: { quality: '240p', ext: 'mp4' },
  645: { quality: '360p', ext: 'mp4' }, 646: { quality: '480p', ext: 'mp4' },
  647: { quality: '720p', ext: 'mp4' }, 648: { quality: '1080p', ext: 'mp4' },
  649: { quality: '1440p', ext: 'mp4' }, 650: { quality: '2160p', ext: 'mp4' },
  651: { quality: '4320p', ext: 'mp4' },
  652: { quality: '144p HDR', hdr: true, ext: 'mp4' },
  653: { quality: '240p HDR', hdr: true, ext: 'mp4' },
  654: { quality: '360p HDR', hdr: true, ext: 'mp4' },
  655: { quality: '480p HDR', hdr: true, ext: 'mp4' },
  656: { quality: '720p HDR', hdr: true, ext: 'mp4' },
  657: { quality: '1080p HDR', hdr: true, ext: 'mp4' },
  658: { quality: '1440p HDR', hdr: true, ext: 'mp4' },
  659: { quality: '2160p HDR', hdr: true, ext: 'mp4' },
  // Audio
  139: { quality: '48kbps', ext: 'm4a' }, 140: { quality: '128kbps', ext: 'm4a' },
  141: { quality: '256kbps', ext: 'm4a' },
  171: { quality: '128kbps', ext: 'ogg' }, 172: { quality: '256kbps', ext: 'ogg' },
  249: { quality: '48kbps', ext: 'opus' }, 250: { quality: '64kbps', ext: 'opus' },
  251: { quality: '160kbps', ext: 'opus' },
  633: { quality: '48kbps', ext: 'opus' }, 634: { quality: '64kbps', ext: 'opus' },
  635: { quality: '96kbps', ext: 'opus' }, 636: { quality: '128kbps', ext: 'opus' },
  637: { quality: '160kbps', ext: 'm4a' }, 638: { quality: '160kbps', ext: 'opus' },
  639: { quality: '192kbps', ext: 'opus' }, 640: { quality: '256kbps', ext: 'm4a' },
  641: { quality: '256kbps', ext: 'opus' }, 642: { quality: '320kbps', ext: 'opus' },
};

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
  fps?: number;
  hdr?: boolean;
  bitrate?: number;
};

// --- Formatting helpers ---

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function resText(w?: number, h?: number): string {
  if (!w || !h) return '—';
  return `${w}×${h}`;
}

function qualityColor(h?: number): string {
  if (!h) return '#a1a1aa';
  if (h >= 4320) return '#a855f7';
  if (h >= 2160) return '#a855f7';
  if (h >= 1440) return '#3b82f6';
  if (h >= 1080) return '#22c55e';
  if (h >= 720) return '#22c55e';
  if (h >= 480) return '#f59e0b';
  if (h >= 360) return '#f59e0b';
  return '#ef4444';
}

function codecShort(codec?: string): string {
  if (!codec) return '';
  const c = codec.toLowerCase();
  if (c.includes('av01')) return 'AV1';
  if (c.includes('hev') || c.includes('hvc')) return 'H.265';
  if (c.includes('avc')) return 'H.264';
  if (c.includes('vp9') || c.includes('vp09')) return 'VP9';
  if (c.includes('vp8')) return 'VP8';
  if (c.includes('opus')) return 'Opus';
  if (c.includes('mp4a') || c.includes('aac')) return 'AAC';
  if (c.includes('vorbis')) return 'Vorbis';
  return codec.split('.')[0]?.slice(0, 12) || codec;
}

function estSize(item: PanelCandidate, durationSec?: number): string {
  if (item.sizeBytes && item.sizeBytes > 0) return formatSize(item.sizeBytes);
  if (item.bitrate && durationSec) {
    return `~${formatSize(Math.round((item.bitrate * durationSec) / 8))}`;
  }
  return '';
}

function formatExt(fmt?: string): string {
  if (!fmt) return '';
  const f = fmt.toLowerCase();
  const map: Record<string, string> = {
    mp4: 'MP4', webm: 'WebM', m4a: 'M4A', mkv: 'MKV', flv: 'FLV',
    '3gp': '3GP', ts: 'TS', ogg: 'OGG',
  };
  return map[f] || f.toUpperCase();
}

// --- Toast notification ---

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

// --- Bridge state check ---

async function checkBridgeState(): Promise<void> {
  try {
    const state = await browser.runtime.sendMessage({ type: 'GET_BRIDGE_STATE' }) as { canSend?: boolean } | undefined;
    const wasConnected = bridgeConnected;
    bridgeConnected = Boolean(state?.canSend);
    if (wasConnected !== bridgeConnected && panelVisible) {
      renderPanel();
    }
  } catch {
    bridgeConnected = false;
  }
}

// --- Core logic ---

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
    quality: w && h ? qualFromHeight(h) : undefined,
    type: isVideo ? 'video' : 'audio',
    width: w || undefined,
    height: h || undefined,
    durationSec: dur || undefined,
    format: fmt,
  };
}

function qualFromHeight(h: number): string {
  if (h >= 4320) return '4320p';
  if (h >= 2160) return '4K';
  if (h >= 1440) return '1440p';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  if (h >= 360) return '360p';
  return `${h}p`;
}

function extractFormat(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop()?.split('?')[0]?.toLowerCase();
    if (ext) return ext;
  } catch { /* invalid URL - use heuristic */ }
  if (url.includes('.m3u8') || url.includes('mime=audio') || url.includes('mime=video')) return 'mp4';
  return '';
}

function collectFromPlayerConfig(): { candidates: PanelCandidate[]; title?: string; thumbnail?: string; durationSec?: number } {
  const results: PanelCandidate[] = [];
  let title: string | undefined;
  let thumbnail: string | undefined;
  let durationSec: number | undefined;
  try {
    const w = window as unknown as Record<string, unknown>;
    const playerResponse = (w.ytInitialPlayerResponse) as Record<string, unknown> | undefined;
    if (!playerResponse) return { candidates: results };
    const vd = playerResponse.videoDetails as Record<string, unknown> | undefined;
    if (vd) {
      title = vd.title as string | undefined;
      const thumbnails = (vd.thumbnail as Record<string, unknown>)?.thumbnails as Array<Record<string, unknown>> | undefined;
      const thumbUrl = thumbnails?.[thumbnails.length - 1]?.url as string | undefined;
      thumbnail = thumbUrl || `https://i.ytimg.com/vi/${vd.videoId}/hqdefault.jpg`;
      durationSec = parseInt(vd.lengthSeconds as string, 10) || undefined;
    }
    const streamingData = (playerResponse as Record<string, unknown>).streamingData as Record<string, unknown> | undefined;
    if (!streamingData) return { candidates: results, title, thumbnail, durationSec };
    const formats = [
      ...((streamingData.formats ?? []) as Array<Record<string, unknown>>),
      ...((streamingData.adaptiveFormats ?? []) as Array<Record<string, unknown>>),
    ];
    for (const fmt of formats) {
      const url = fmt.url as string | undefined;
      if (!url) continue;
      const mime = (fmt.mimeType as string) || '';
      const isAudio = mime.startsWith('audio');
      const h = fmt.height as number | undefined;
      const w = fmt.width as number | undefined;
      const contentLength = fmt.contentLength ? parseInt(fmt.contentLength as string, 10) : undefined;
      const codecMatch = mime.match(/codecs="([^"]+)"/);
      const itag = fmt.itag as number | undefined;
      const fps = fmt.fps as number | undefined;
      const bitrate = fmt.bitrate as number | undefined;
      const qualityLabel = fmt.qualityLabel as string | undefined;
      const container = mime.split(';')[0]?.split('/')[1] || (itag !== undefined ? ITAG_QUALITY[itag]?.ext : undefined) || 'mp4';

      let quality: string | undefined;
      let finalFps: number | undefined;
      let hdr = false;
      if (qualityLabel) {
        quality = qualityLabel;
        finalFps = fps;
      } else if (itag !== undefined && ITAG_QUALITY[itag]) {
        const entry = ITAG_QUALITY[itag]!;
        quality = entry.quality;
        finalFps = entry.fps || fps;
        hdr = entry.hdr || false;
      } else if (h && !isAudio) {
        quality = qualFromHeight(h);
        finalFps = fps;
      } else if (bitrate) {
        quality = `${Math.round(bitrate / 1000)} kbps`;
      }

      results.push({
        id: `cfg-${itag ?? btoa(url).slice(0, 16)}`,
        url,
        quality,
        sizeBytes: Number.isFinite(contentLength) ? contentLength : undefined,
        codec: codecMatch?.[1],
        format: container,
        type: isAudio ? 'audio' : 'video',
        width: w,
        height: h,
        fps: finalFps,
        hdr,
        bitrate,
      });
    }
  } catch { /* player config parse failure */ }
  return { candidates: results, title, thumbnail, durationSec };
}

// --- Shadow DOM Panel ---

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
      min-width: 220px;
      max-width: 520px;
      max-height: 70vh;
      background: rgba(8, 8, 14, 1);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 11px;
      color: #e4e4e7;
      overflow: hidden;
      pointer-events: auto;
      transition: opacity 0.35s ease, box-shadow 0.35s ease;
      opacity: ${PANEL_OPACITY_DEFAULT};
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      user-select: none;
    }
    .nova-panel:hover {
      opacity: ${PANEL_OPACITY_HOVER};
      box-shadow: 0 8px 36px rgba(59, 130, 246, 0.15), 0 8px 32px rgba(0,0,0,0.6);
    }
    .nova-panel.nova-panel-expanded {
      opacity: ${PANEL_OPACITY_HOVER};
      min-width: 380px;
      box-shadow: 0 8px 36px rgba(59, 130, 246, 0.15), 0 8px 32px rgba(0,0,0,0.6);
    }
    .nova-compact {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      cursor: move;
    }
    .nova-compact-icon { width: 16px; height: 16px; fill: #3b82f6; flex-shrink: 0; }
    .nova-compact-label {
      font-size: 11px;
      font-weight: 600;
      color: #a1a1aa;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .nova-compact-count {
      background: #3b82f6;
      color: #fff;
      border-radius: 8px;
      padding: 1px 6px;
      font-size: 9px;
      font-weight: 700;
      min-width: 16px;
      text-align: center;
      flex-shrink: 0;
    }
    .nova-compact-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 5px 12px;
      border-radius: 6px;
      border: 1px solid rgba(59, 130, 246, 0.4);
      background: rgba(59, 130, 246, 0.15);
      color: #93c5fd;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .nova-compact-btn:hover { background: rgba(59, 130, 246, 0.3); border-color: #3b82f6; color: #fff; }
    .nova-compact-btn svg { width: 12px; height: 12px; }
    .nova-close-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      color: #71717a;
      cursor: pointer;
      transition: all 0.15s;
      flex-shrink: 0;
      padding: 0;
      font-size: 12px;
      line-height: 1;
    }
    .nova-close-btn:hover { color: #ef4444; background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.3); }
    .nova-close-btn svg { width: 12px; height: 12px; }
    .nova-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      cursor: move;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.02);
    }
    .nova-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nova-header-icon { width: 18px; height: 18px; fill: #3b82f6; }
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
      padding: 1px 8px;
      font-size: 10px;
      font-weight: 700;
      min-width: 20px;
      text-align: center;
    }
    .nova-body { overflow-y: auto; max-height: 55vh; }
    .nova-body::-webkit-scrollbar { width: 4px; }
    .nova-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
    .nova-video-info {
      display: flex;
      gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      background: rgba(255,255,255,0.015);
    }
    .nova-thumb {
      width: 88px;
      height: 50px;
      border-radius: 6px;
      object-fit: cover;
      flex-shrink: 0;
      background: rgba(255,255,255,0.05);
    }
    .nova-video-meta { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .nova-video-title {
      font-size: 11px;
      font-weight: 600;
      line-height: 1.3;
      color: #fafafa;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .nova-video-sub {
      font-size: 9px;
      color: #71717a;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .nova-q-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 10px;
    }
    .nova-q-table thead th {
      text-align: left;
      font-weight: 500;
      color: #52525b;
      font-size: 8px;
      text-transform: uppercase;
      letter-spacing: .04em;
      padding: 4px 8px 4px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.015);
    }
    .nova-q-table thead th:last-child { text-align: center; padding-right: 14px; }
    .nova-q-table tbody td {
      padding: 5px 8px 5px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.03);
      vertical-align: middle;
      color: #d4d4d8;
      transition: background 0.12s;
    }
    .nova-q-table tbody tr:hover { background: rgba(59, 130, 246, 0.06); }
    .nova-q-table tbody tr:last-child td { border-bottom: none; }
    .nova-q-table tbody td:last-child { text-align: center; padding-right: 14px; }
    .nova-q-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 9px;
      font-weight: 700;
      line-height: 1.2;
    }
    .nova-q-hdr { color: #f59e0b; margin-right: 2px; font-size: 7px; }
    .nova-q-fps { display: inline-block; font-size: 8px; font-weight: 600; color: #22c55e; margin-left: 3px; }
    .nova-q-codec { font-size: 9px; color: #c084fc; font-weight: 500; }
    .nova-q-send {
      font-size: 10px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 5px;
      border: 1px solid rgba(59, 130, 246, 0.4);
      background: rgba(59, 130, 246, 0.15);
      color: #93c5fd;
      cursor: pointer;
      transition: all 0.15s;
    }
    .nova-q-send:hover { background: rgba(59, 130, 246, 0.3); border-color: #3b82f6; color: #fff; }
    .nova-q-send[data-sent="true"] {
      background: rgba(34, 197, 94, 0.15);
      border-color: rgba(34, 197, 94, 0.4);
      color: #4ade80;
    }
    .nova-footer {
      display: flex;
      gap: 8px;
      padding: 10px 14px;
      border-top: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.015);
    }
    .nova-btn {
      flex: 1;
      padding: 7px 12px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
    }
    .nova-btn-best {
      background: rgba(59, 130, 246, 0.15);
      border-color: rgba(59, 130, 246, 0.4);
      color: #93c5fd;
    }
    .nova-btn-best:hover { background: rgba(59, 130, 246, 0.3); border-color: #3b82f6; color: #fff; }
    .nova-btn-scan {
      background: rgba(255,255,255,0.04);
      border-color: rgba(255,255,255,0.08);
      color: #a1a1aa;
    }
    .nova-btn-scan:hover { background: rgba(255,255,255,0.08); color: #e4e4e7; }
    .nova-btn-send-all {
      background: #3b82f6;
      border-color: #3b82f6;
      color: #fff;
    }
    .nova-btn-send-all:hover { background: #2563eb; }
    .nova-empty {
      padding: 24px 16px;
      text-align: center;
      color: #52525b;
      font-size: 11px;
    }
    .nova-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(8, 8, 14, 1);
      border: 1px solid rgba(34, 197, 94, 0.4);
      border-radius: 8px;
      padding: 8px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 11px;
      font-weight: 600;
      color: #4ade80;
      z-index: 2147483647;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s ease, transform 0.3s ease;
      white-space: nowrap;
    }
    .nova-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .nova-toast.error { border-color: rgba(239,68,68,0.4); color: #ef4444; }
    .nova-btn-send-all-nova {
      background: #3b82f6;
      border-color: #3b82f6;
      color: #fff;
    }
    .nova-btn-send-all-nova:hover { background: #2563eb; }
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
  const handler = (e: MouseEvent) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('.nova-compact-btn, .nova-close-btn, .nova-q-send, .nova-btn, button')) return;
    isDragging = true;
    const rect = el.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    el.style.transition = 'none';
    e.preventDefault();
  };

  el.addEventListener('mousedown', handler);

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
    if (isDragging && panelEl) {
      isDragging = false;
      panelEl.style.transition = '';
    }
  });
}

function positionPanelAtVideo(): void {
  if (!panelEl || isDragging || savedPosition) return;
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

// --- Store video metadata ---
let videoMeta: { title?: string; thumbnail?: string; durationSec?: number } = {};

function renderPanel(): void {
  if (!panelEl) return;

  if (currentCandidates.length === 0) {
    if (panelVisible) {
      panelEl.style.opacity = '0';
      panelEl.style.pointerEvents = 'none';
      panelVisible = false;
    }
    return;
  }

  if (currentCandidates.length > 0 && !panelVisible) {
    panelEl.style.opacity = `${PANEL_OPACITY_DEFAULT}`;
    panelEl.style.pointerEvents = 'auto';
    panelVisible = true;
    panelEl.style.transition = 'opacity 0.15s ease, box-shadow 0.2s ease';
    panelEl.style.boxShadow = '0 8px 36px rgba(59, 130, 246, 0.3), 0 8px 32px rgba(0,0,0,0.6)';
    setTimeout(() => {
      if (panelEl) {
        panelEl.style.boxShadow = '0 8px 32px rgba(0,0,0,0.6)';
        panelEl.style.transition = 'opacity 0.35s ease, box-shadow 0.35s ease';
      }
    }, 400);
  }

  const videos = currentCandidates.filter((c) => c.type === 'video' && c.height);
  const mergedVideos = currentCandidates.filter((c) => c.type === 'video' && !c.height && !c.width);
  const audios = currentCandidates.filter((c) => c.type === 'audio');

  if (!panelExpanded) {
    const totalVideos = videos.length + mergedVideos.length;
    const totalAudios = audios.length;
    let countLabel = '';
    if (totalVideos > 0) countLabel += `V:${totalVideos}`;
    if (totalAudios > 0) countLabel += `${countLabel ? ' ' : ''}A:${totalAudios}`;

    panelEl.innerHTML = `
      <div class="nova-compact" data-drag="header">
        <svg class="nova-compact-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/><path d="M3 5h2v14H3z" opacity="0.5"/></svg>
        <span class="nova-compact-label">NOVA</span>
        ${countLabel ? `<span class="nova-compact-count">${esc(countLabel)}</span>` : ''}
        <button class="nova-compact-btn" data-action="expand">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
        <button class="nova-close-btn" data-action="close" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `;

    panelEl.querySelectorAll('[data-action="expand"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        panelExpanded = true;
        panelEl?.classList.add('nova-panel-expanded');
        renderPanel();
      });
    });

    panelEl.querySelectorAll('[data-action="close"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        panelVisible = false;
        panelExpanded = false;
        panelEl?.classList.remove('nova-panel-expanded');
        if (panelEl) {
          panelEl.style.opacity = '0';
          panelEl.style.pointerEvents = 'none';
        }
      });
    });

    return;
  }

  const sortedVideos = [...videos].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  const sortedAudios = [...audios].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0));

  const allSorted: PanelCandidate[] = [
    ...sortedVideos,
    ...mergedVideos,
    ...sortedAudios,
  ];

  const totalFormats = videos.length + mergedVideos.length + audios.length;

  let html = `
    <div class="nova-header">
      <div class="nova-header-left">
        <svg class="nova-header-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/><path d="M3 5h2v14H3z" opacity="0.5"/></svg>
        <span class="nova-header-title">Qualities</span>
        <span class="nova-header-count">${currentCandidates.length}</span>
        ${videos.length > 0 ? `<span style="font-size:9px;color:#93c5fd;margin-left:2px">V:${videos.length}</span>` : ''}
        ${audios.length > 0 ? `<span style="font-size:9px;color:#c084fc;margin-left:2px">A:${audios.length}</span>` : ''}
      </div>
      <button class="nova-close-btn" data-action="collapse" title="Collapse">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `;

  html += '<div class="nova-body">';

  if (videoMeta.title || videoMeta.thumbnail) {
    html += `
      <div class="nova-video-info">
        ${videoMeta.thumbnail ? `<img class="nova-thumb" src="${esc(videoMeta.thumbnail)}" alt="" />` : ''}
        <div class="nova-video-meta">
          ${videoMeta.title ? `<div class="nova-video-title">${esc(videoMeta.title)}</div>` : ''}
          <div class="nova-video-sub">
            <span>${totalFormats} formats</span>
            ${videoMeta.durationSec ? `<span>${formatDuration(videoMeta.durationSec)}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  html += `
    <table class="nova-q-table">
      <thead><tr>
        <th>Quality</th>
        <th>Resolution</th>
        <th>Codec</th>
        <th>FPS</th>
        <th>Container</th>
        <th>Size</th>
        <th></th>
      </tr></thead>
      <tbody>
  `;
  for (const c of allSorted) {
    const isAudio = c.type === 'audio';
    const isQuick = !c.height && !c.width && c.type === 'video';
    const color = isAudio ? '#c084fc' : qualityColor(c.height);
    const bg = isAudio ? '#a855f722' : `${color}22`;
    const border = isAudio ? '#a855f744' : `${color}44`;
    const sizeStr = c.sizeBytes ? formatSize(c.sizeBytes) : estSize(c, videoMeta.durationSec);
    const containerFmt = formatExt(c.format);
    html += `
      <tr>
        <td>
          <span class="nova-q-badge" style="background:${bg};color:${color};border:1px solid ${border}">
            ${isAudio ? '<span class="nova-q-hdr" style="color:#c084fc">♫ </span>' : ''}${c.hdr && !isAudio ? '<span class="nova-q-hdr">HDR</span>' : ''}${isQuick ? (c.quality || 'Video') : (c.quality || '?')}
          </span>
          ${c.fps && c.fps >= 50 && !isAudio ? `<span class="nova-q-fps">${c.fps}fps</span>` : ''}
        </td>
        <td style="color:#a1a1aa">${isAudio ? (c.quality || 'Audio') : resText(c.width, c.height)}</td>
        <td><span class="nova-q-codec">${codecShort(c.codec)}</span></td>
        <td style="color:#a1a1aa">${c.fps ? `${c.fps}fps` : '—'}</td>
        <td style="color:#a1a1aa;font-size:9px">${containerFmt || '—'}</td>
        <td style="color:#a1a1aa;font-variant-numeric:tabular-nums">${sizeStr || '—'}</td>
        <td><button class="nova-q-send" data-action="send" data-id="${esc(c.id)}">Download</button></td>
      </tr>
    `;
  }
  html += '</tbody></table>';
  html += '</div>';

  html += `
    <div class="nova-footer">
      <button class="nova-btn nova-btn-best" data-action="send-best">Best Quality</button>
      <button class="nova-btn nova-btn-send-all-nova" data-action="send-all">Send All to NOVA</button>
      <button class="nova-btn nova-btn-scan" data-action="scan">Rescan</button>
    </div>
  `;

  panelEl.innerHTML = html;

  panelEl.querySelectorAll('[data-action="collapse"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      panelExpanded = false;
      panelEl?.classList.remove('nova-panel-expanded');
      renderPanel();
    });
  });

  panelEl.querySelectorAll('[data-action="send"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (el as HTMLElement).dataset.id;
      if (id) {
        markSent(el as HTMLElement);
        sendCandidate(id);
      }
    });
  });

  panelEl.querySelectorAll('[data-action="send-best"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      sendBestQuality();
    });
  });

  panelEl.querySelectorAll('[data-action="send-all"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      sendAllCandidates();
    });
  });

  panelEl.querySelectorAll('[data-action="scan"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      scanCurrentTab();
    });
  });
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function markSent(el: HTMLElement): void {
  el.setAttribute('data-sent', 'true');
  el.textContent = 'Done';
  el.setAttribute('disabled', 'true');
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
    bitrate: c.bitrate,
    confidence: 85,
  };
}

function sendCandidate(id: string): void {
  const c = currentCandidates.find((x) => x.id === id);
  if (!c) return;
  if (!bridgeConnected) {
    showToast('NOVA desktop not connected', true);
    return;
  }
  void browser.runtime.sendMessage({ type: 'SEND_CANDIDATE', candidate: panelCandidateToCandidate(c) })
    .then(() => showToast(`Sent ${c.quality || c.type} to NOVA`))
    .catch(() => showToast('Failed to send to NOVA', true));
}

function sendBestQuality(): void {
  if (!bridgeConnected) {
    showToast('NOVA desktop not connected', true);
    return;
  }
  const videos = currentCandidates
    .filter((c) => c.type === 'video')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  if (videos.length > 0) {
    sendCandidate(videos[0]!.id);
    return;
  }
  const audios = currentCandidates
    .filter((c) => c.type === 'audio')
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  if (audios.length > 0) {
    sendCandidate(audios[0]!.id);
  }
}

function sendAllCandidates(): void {
  if (currentCandidates.length === 0) return;
  if (!bridgeConnected) {
    showToast('NOVA desktop not connected', true);
    return;
  }
  const batchCandidates = currentCandidates.map(panelCandidateToCandidate);
  void browser.runtime.sendMessage({ type: 'SEND_BATCH', candidates: batchCandidates })
    .then(() => showToast(`Sent ${currentCandidates.length} items to NOVA`))
    .catch(() => showToast('Failed to send batch to NOVA', true));
}

function scanCurrentTab(): void {
  void browser.runtime.sendMessage({ type: 'SCAN_PAGE', userActivated: true }).catch(() => {});
}

function updateCandidates(newCandidates: PanelCandidate[]): void {
  const existingIds = new Set(currentCandidates.map((c) => c.id));
  let added = 0;
  for (const nc of newCandidates) {
    if (!existingIds.has(nc.id)) {
      currentCandidates.push(nc);
      added++;
    } else {
      const existing = currentCandidates.find((c) => c.id === nc.id);
      if (existing) {
        if (nc.sizeBytes && !existing.sizeBytes) existing.sizeBytes = nc.sizeBytes;
        if (nc.codec && !existing.codec) existing.codec = nc.codec;
        if (nc.quality && !existing.quality) existing.quality = nc.quality;
        if (nc.fps && !existing.fps) existing.fps = nc.fps;
        if (nc.bitrate && !existing.bitrate) existing.bitrate = nc.bitrate;
      }
    }
  }
  if (added > 0) emptyScanCount = 0;
  currentCandidates.sort((a, b) => {
    if ((b.height ?? 0) !== (a.height ?? 0)) return (b.height ?? 0) - (a.height ?? 0);
    return (b.type === 'video' ? 1 : 0) - (a.type === 'video' ? 1 : 0);
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
  const playerResult = collectFromPlayerConfig();
  if (playerResult.title) videoMeta.title = playerResult.title;
  if (playerResult.thumbnail) videoMeta.thumbnail = playerResult.thumbnail;
  if (playerResult.durationSec) videoMeta.durationSec = playerResult.durationSec;
  candidates.push(...playerResult.candidates);
  if (candidates.length > 0) {
    updateCandidates(candidates);
  } else {
    emptyScanCount++;
    if (panelEl && panelVisible && emptyScanCount >= 3) renderPanel();
  }
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
      quality: data.qualityLabel || (data.width && data.height ? qualFromHeight(data.height) : undefined),
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
  checkBridgeState();
  scanMediaElements();
  listenForPageTapEvents();
  positionPanelAtVideo();
  setInterval(scanMediaElements, CHECK_INTERVAL_MS);
  setInterval(checkBridgeState, 5000);

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
