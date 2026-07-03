import browser from 'webextension-polyfill';
import { defaultSettings, SettingsSchema, type OverlaySettings } from '../contracts/settings.schema';
import {
  DOWNLOAD_OVERLAY_POSITION_STORAGE_PREFIX,
  OVERLAY_DIAGNOSTICS_STORAGE_KEY,
  OVERLAY_EDGE_MARGIN,
  SETTINGS_STORAGE_KEY,
  type SavedOverlayPosition,
  VIDEO_OVERLAY_POSITION_STORAGE_KEY,
} from './overlay-types';

type OverlayPlacement = 'up' | 'down' | 'left' | 'right';
type OverlayAlignment = 'start' | 'center' | 'end';

async function readOverlaySettings(): Promise<OverlaySettings> {
  try {
    const stored = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
    return SettingsSchema.catch(defaultSettings).parse(stored[SETTINGS_STORAGE_KEY] ?? {}).overlay;
  } catch {
    return defaultSettings.overlay;
  }
}

async function writeOverlayClientDiagnostics(patch: Record<string, unknown>): Promise<void> {
  try {
    const current = await browser.storage.local.get(OVERLAY_DIAGNOSTICS_STORAGE_KEY);
    const existing = current[OVERLAY_DIAGNOSTICS_STORAGE_KEY];
    const safeExisting =
      existing && typeof existing === 'object' ? (existing as Record<string, unknown>) : {};
    const client =
      safeExisting.client && typeof safeExisting.client === 'object'
        ? (safeExisting.client as Record<string, unknown>)
        : {};
    await browser.storage.local.set({
      [OVERLAY_DIAGNOSTICS_STORAGE_KEY]: {
        ...safeExisting,
        client: {
          ...client,
          ...patch,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          updatedAt: new Date().toISOString(),
        },
      },
    });
  } catch {
    // Client diagnostics are best effort and must never affect page interaction.
  }
}

function overlayRectSnapshot(host: HTMLElement): Record<string, number> {
  const rect = host.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function overlayVisualSize(settings: OverlaySettings): number {
  return Math.round(settings.buttonSizePx * settings.scale);
}

function overlayEstimatedWidth(settings: OverlaySettings): number {
  const size = overlayVisualSize(settings);
  if (settings.compactPermanentActions && !settings.showProgramLogo)
    return Math.max(size, Math.round(size * 2.85));
  if (settings.compactPermanentActions) return Math.max(size, Math.round(size * 3.75));
  return size;
}

function overlayEstimatedHeight(settings: OverlaySettings): number {
  const size = overlayVisualSize(settings);
  return settings.compactPermanentActions ? Math.max(34, Math.round(size * 0.82)) : size;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeSavedOverlayPosition(value: unknown): SavedOverlayPosition | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const left = readNumber(record.left);
  const top = readNumber(record.top);
  if (left === undefined || top === undefined) return undefined;
  return {
    left,
    top,
    viewportWidth: readNumber(record.viewportWidth),
    viewportHeight: readNumber(record.viewportHeight),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
  };
}

function currentOverlayPositionScopeKey(settings: OverlaySettings): string {
  const scope = settings.positionScope ?? 'global';
  if (scope === 'global') return VIDEO_OVERLAY_POSITION_STORAGE_KEY;
  const host = location.hostname || 'local';
  if (scope === 'domain') return `${DOWNLOAD_OVERLAY_POSITION_STORAGE_PREFIX}.domain.${host}`;
  const origin =
    location.origin && location.origin !== 'null'
      ? location.origin
      : location.href.split(/[?#]/, 1)[0];
  return `${DOWNLOAD_OVERLAY_POSITION_STORAGE_PREFIX}.site.${origin}`;
}

async function readSavedOverlayPosition(
  settings: OverlaySettings,
): Promise<SavedOverlayPosition | undefined> {
  if (!settings.rememberDraggedPosition) return undefined;
  const primaryKey = currentOverlayPositionScopeKey(settings);
  try {
    const stored = await browser.storage.local.get([
      primaryKey,
      VIDEO_OVERLAY_POSITION_STORAGE_KEY,
    ]);
    return (
      sanitizeSavedOverlayPosition(stored[primaryKey]) ??
      (primaryKey === VIDEO_OVERLAY_POSITION_STORAGE_KEY
        ? undefined
        : sanitizeSavedOverlayPosition(stored[VIDEO_OVERLAY_POSITION_STORAGE_KEY]))
    );
  } catch {
    return undefined;
  }
}

async function saveOverlayPosition(host: HTMLElement, settings: OverlaySettings): Promise<void> {
  if (!settings.rememberDraggedPosition) return;
  const rect = host.getBoundingClientRect();
  const payload: SavedOverlayPosition = {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    updatedAt: new Date().toISOString(),
  };
  await browser.storage.local
    .set({ [currentOverlayPositionScopeKey(settings)]: payload })
    .catch(() => undefined);
}

function applyAbsoluteOverlayPosition(
  host: HTMLElement,
  left: number,
  top: number,
  settings: OverlaySettings,
): void {
  const width = overlayEstimatedWidth(settings);
  const height = overlayEstimatedHeight(settings);
  const maxLeft = Math.max(OVERLAY_EDGE_MARGIN, window.innerWidth - width - OVERLAY_EDGE_MARGIN);
  const maxTop = Math.max(OVERLAY_EDGE_MARGIN, window.innerHeight - height - OVERLAY_EDGE_MARGIN);
  host.style.inset = 'auto auto auto auto';
  host.style.left = `${clamp(left, OVERLAY_EDGE_MARGIN, maxLeft)}px`;
  host.style.top = `${clamp(top, OVERLAY_EDGE_MARGIN, maxTop)}px`;
  host.style.right = 'auto';
  host.style.bottom = 'auto';
}

function findFirstVideoElement(): HTMLVideoElement | undefined {
  return document.querySelector('video[src],video > source[src]')?.closest('video') ?? undefined;
}

function applyDefaultOverlayPosition(
  host: HTMLElement,
  settings: OverlaySettings,
  saved?: SavedOverlayPosition,
): void {
  const width = overlayEstimatedWidth(settings);
  const height = overlayEstimatedHeight(settings);
  host.style.position = 'fixed';
  host.style.zIndex = String(settings.zIndex);
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  host.style.pointerEvents = 'auto';
  host.style.overflow = 'visible';

  if (saved) {
    applyAbsoluteOverlayPosition(host, saved.left, saved.top, settings);
    return;
  }

  const video = findFirstVideoElement();
  if (video) {
    const rect = video.getBoundingClientRect();
    const left = Math.min(
      rect.right + OVERLAY_EDGE_MARGIN,
      window.innerWidth - width - OVERLAY_EDGE_MARGIN,
    );
    const top = Math.max(OVERLAY_EDGE_MARGIN, rect.top);
    applyAbsoluteOverlayPosition(host, left, top, settings);
    return;
  }

  switch (settings.defaultPosition) {
    case 'top-left':
      host.style.inset = '86px auto auto 18px';
      break;
    case 'bottom-right':
      host.style.inset = 'auto 18px 88px auto';
      break;
    case 'bottom-left':
      host.style.inset = 'auto auto 88px 18px';
      break;
    case 'custom':
    case 'top-right':
    default:
      host.style.inset = '86px 18px auto auto';
      break;
  }
}

function chooseOverlayPlacement(
  host: HTMLElement,
  requested: OverlaySettings['openDirection'],
): OverlayPlacement {
  if (requested !== 'auto') return requested;
  const rect = host.getBoundingClientRect();
  const menuWidth = 136;
  const menuHeight = 48;
  const spaceAbove = rect.top;
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceLeft = rect.left;
  const spaceRight = window.innerWidth - rect.right;

  if (spaceBelow >= menuHeight + OVERLAY_EDGE_MARGIN && rect.top < menuHeight + OVERLAY_EDGE_MARGIN)
    return 'down';
  if (
    spaceAbove >= menuHeight + OVERLAY_EDGE_MARGIN &&
    rect.bottom > window.innerHeight - menuHeight - OVERLAY_EDGE_MARGIN
  )
    return 'up';
  if (spaceLeft >= menuWidth + OVERLAY_EDGE_MARGIN && spaceRight < menuWidth / 2) return 'left';
  if (spaceRight >= menuWidth + OVERLAY_EDGE_MARGIN && spaceLeft < menuWidth / 2) return 'right';
  return spaceAbove >= spaceBelow ? 'up' : 'down';
}

function chooseOverlayAlignment(host: HTMLElement): OverlayAlignment {
  const rect = host.getBoundingClientRect();
  const menuWidth = 136;
  if (rect.left < menuWidth / 2) return 'start';
  if (window.innerWidth - rect.right < menuWidth / 2) return 'end';
  return 'center';
}

export {
  clamp,
  readOverlaySettings,
  writeOverlayClientDiagnostics,
  overlayRectSnapshot,
  overlayVisualSize,
  overlayEstimatedWidth,
  overlayEstimatedHeight,
  readNumber,
  sanitizeSavedOverlayPosition,
  currentOverlayPositionScopeKey,
  readSavedOverlayPosition,
  saveOverlayPosition,
  applyAbsoluteOverlayPosition,
  findFirstVideoElement,
  applyDefaultOverlayPosition,
  chooseOverlayPlacement,
  chooseOverlayAlignment,
};
export type { OverlayPlacement, OverlayAlignment };
