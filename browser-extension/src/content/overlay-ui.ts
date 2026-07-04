import browser from 'webextension-polyfill';
import type { OverlaySettings } from '../contracts/settings.schema';
import { getDefaultLocale, getLocaleBundle, translate } from '../i18n';
import { formatBytes } from '../utils/text';
import { safeDisplayUrl } from '../utils/url';
import {
  CANDIDATE_CACHE_STORAGE_PREFIX,
  type OverlayCandidate,
  OVERLAY_EDGE_MARGIN,
  OVERLAY_REFRESH_MESSAGE_TYPE,
  OVERLAY_SCAN_MESSAGE_TYPE,
  PICKER_DESTROY_EVENT,
  PICKER_HOST_ID,
  PICKER_LIVE_BURST_MS,
  PICKER_MAX_CONTINUOUS_REFRESH_ROUNDS,
  PICKER_STEADY_REFRESH_MIN_MS,
  VIDEO_OVERLAY_DESTROY_EVENT,
  VIDEO_OVERLAY_HOST_ID,
  VIDEO_OVERLAY_LIVE_REFRESH_EVENT,
  VIDEO_OVERLAY_USER_CLOSE_EVENT,
} from './overlay-types';
import { extensionHintFromUrl, isSmartVideoUrlHint } from './overlay-detect';
import {
  applyAbsoluteOverlayPosition,
  applyDefaultOverlayPosition,
  chooseOverlayAlignment,
  chooseOverlayPlacement,
  clamp,
  overlayEstimatedHeight,
  overlayEstimatedWidth,
  overlayRectSnapshot,
  overlayVisualSize,
  readSavedOverlayPosition,
  saveOverlayPosition,
  writeOverlayClientDiagnostics,
} from './overlay-position';
import { videoOverlayCss } from './overlay-ui-video.css';
import { pickerCss } from './overlay-ui-picker.css';

function applyShadowStyles(shadow: ShadowRoot, css: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    return;
  } catch {
    // Constructable stylesheets unsupported; fall through to a <style> element.
  }
  const style = document.createElement('style');
  style.textContent = css;
  shadow.append(style);
}

function destroyVideoOverlayHost(host: HTMLElement | null | undefined): void {
  if (!host) return;
  void writeOverlayClientDiagnostics({ state: 'destroyed', rect: overlayRectSnapshot(host) });
  host.dispatchEvent(new CustomEvent(VIDEO_OVERLAY_DESTROY_EVENT));
  host.remove();
}

function destroyCandidatePickerHost(host: HTMLElement | null | undefined): void {
  if (!host) return;
  host.dispatchEvent(new CustomEvent(PICKER_DESTROY_EVENT));
  host.remove();
}

async function createVideoOverlayHost(settings: OverlaySettings): Promise<HTMLElement> {
  const locale = getDefaultLocale();
  const direction = getLocaleBundle(locale).direction;
  const downloadLabel = translate('videoOverlay.download', locale);
  const closeLabel = translate('videoOverlay.close', locale);
  const size = overlayVisualSize(settings);
  const iconSize = Math.max(20, Math.round(size * 0.65));
  const compactActions = settings.compactPermanentActions;
  const showLogo = settings.showProgramLogo;
  const savedPosition = await readSavedOverlayPosition(settings);
  const host = document.createElement('div');
  host.id = VIDEO_OVERLAY_HOST_ID;
  applyDefaultOverlayPosition(host, settings, savedPosition);

  const shadow = host.attachShadow({ mode: 'open' });

  const popover = document.createElement('div');
  popover.className = 'adm-video-download-popover';
  popover.setAttribute('role', 'group');
  popover.setAttribute('aria-label', downloadLabel);
  popover.dataset.open = 'false';
  popover.dataset.idle = 'false';
  popover.dataset.hasCandidates = 'true';
  popover.dataset.placement = 'down';
  popover.dataset.align = 'end';
  popover.dataset.compact = compactActions ? 'true' : 'false';
  popover.setAttribute('tabindex', '0');
  popover.setAttribute('aria-keyshortcuts', 'Escape ArrowUp ArrowDown ArrowLeft ArrowRight');

  const trigger = document.createElement('div');
  trigger.className = 'adm-video-download-trigger';
  trigger.setAttribute('role', 'button');
  trigger.setAttribute('tabindex', '0');
  trigger.setAttribute('aria-label', downloadLabel);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute(
    'aria-keyshortcuts',
    'Enter Space Escape ArrowUp ArrowDown ArrowLeft ArrowRight',
  );

  if (showLogo) {
    const logo = document.createElement('img');
    logo.className = 'adm-video-download-logo';
    logo.src = browser.runtime.getURL('icons/icon-48.png');
    logo.alt = '';
    logo.draggable = false;
    trigger.append(logo);
  }

  const actions = document.createElement('div');
  actions.className = 'adm-video-download-actions';

  function updatePlacement(): void {
    popover.dataset.placement = chooseOverlayPlacement(host, settings.openDirection);
    popover.dataset.align = chooseOverlayAlignment(host);
    const picker = document.getElementById(PICKER_HOST_ID);
    if (settings.attachPickerToOverlay && picker) positionCandidatePicker(picker, host, true);
  }

  function setOpen(open: boolean): void {
    if (open) updatePlacement();
    popover.dataset.open = open ? 'true' : 'false';
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) popover.dataset.idle = 'false';
    void writeOverlayClientDiagnostics({
      state: open ? 'open' : 'closed',
      placement: popover.dataset.placement,
      alignment: popover.dataset.align,
      rect: overlayRectSnapshot(host),
    });
  }

  function nudgeOverlay(key: string, accelerated: boolean): void {
    const rect = host.getBoundingClientRect();
    const step = settings.keyboardNudgePx * (accelerated ? 5 : 1);
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    applyAbsoluteOverlayPosition(host, rect.left + dx, rect.top + dy, settings);
    updatePlacement();
    void saveOverlayPosition(host, settings);
  }

  let suppressNextClick = false;
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    setOpen(popover.dataset.open !== 'true');
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(popover.dataset.open !== 'true');
    } else if (event.key === 'Escape') {
      setOpen(false);
    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      nudgeOverlay(event.key, event.shiftKey);
    }
  });

  popover.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      nudgeOverlay(event.key, event.shiftKey);
    }
  });

  const label = document.createElement('button');
  label.className = 'adm-video-download-label';
  label.type = 'button';
  label.textContent = downloadLabel;
  let resetLabelTimer: number | undefined;
  function setLabelStatus(text: string, resetAfterMs?: number): void {
    label.textContent = text;
    if (resetLabelTimer !== undefined) window.clearTimeout(resetLabelTimer);
    if (resetAfterMs !== undefined) {
      resetLabelTimer = window.setTimeout(() => {
        resetLabelTimer = undefined;
        label.textContent = downloadLabel;
        label.disabled = false;
      }, resetAfterMs);
    }
  }

  label.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(true);
    label.disabled = true;
    setLabelStatus(translate('videoOverlay.sending', locale));
    try {
      let response = (await browser.runtime.sendMessage({ type: OVERLAY_SCAN_MESSAGE_TYPE })) as
        | { ok?: boolean; candidates?: OverlayCandidate[]; message?: string }
        | undefined;
      if (response?.ok === false && /rate limit/i.test(response.message ?? '')) {
        response = (await browser.runtime.sendMessage({ type: OVERLAY_REFRESH_MESSAGE_TYPE })) as
          | { ok?: boolean; candidates?: OverlayCandidate[]; message?: string }
          | undefined;
      }
      const found = Array.isArray(response?.candidates) ? response!.candidates! : [];
      if (found.length > 0) {
        openCandidatePicker(found, settings, host, trigger);
        setLabelStatus(downloadLabel);
        label.disabled = false;
        setOpen(false);
      } else {
        setLabelStatus(response?.message || translate('videoOverlay.noFiles', locale), 1800);
      }
    } catch {
      setLabelStatus(translate('videoOverlay.sendFailed', locale), 1800);
    }
  });

  const close = document.createElement('button');
  close.className = 'adm-video-download-close';
  close.type = 'button';
  close.setAttribute('aria-label', closeLabel);
  close.textContent = '\u00D7';
  close.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    host.dispatchEvent(new CustomEvent(VIDEO_OVERLAY_USER_CLOSE_EVENT));
  });

  actions.append(label, close);
  popover.append(trigger, actions);
  applyShadowStyles(shadow, videoOverlayCss(size, iconSize, compactActions, direction, settings, overlayEstimatedWidth(settings), overlayEstimatedHeight(settings)));
  shadow.append(popover);
  makeVideoOverlayDraggable(host, popover, settings, updatePlacement, () => {
    suppressNextClick = true;
    void writeOverlayClientDiagnostics({
      state: 'moved',
      placement: popover.dataset.placement,
      alignment: popover.dataset.align,
      rect: overlayRectSnapshot(host),
    });
  });

  let idleTimer: number | undefined;
  const resetIdleState = (): void => {
    if (!settings.autoHideWhenIdle) return;
    popover.dataset.idle = 'false';
    if (idleTimer !== undefined) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      idleTimer = undefined;
      if (popover.dataset.open !== 'true') popover.dataset.idle = 'true';
    }, settings.idleAfterMs);
  };
  if (settings.autoHideWhenIdle) {
    resetIdleState();
    popover.addEventListener('pointerenter', resetIdleState);
    popover.addEventListener('focusin', resetIdleState);
    popover.addEventListener('keydown', resetIdleState);
  }

  const closeOnOutsidePointer = (event: PointerEvent): void => {
    if (event.composedPath().includes(host)) return;
    setOpen(false);
  };
  const closeOnEsc = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') setOpen(false);
  };
  window.addEventListener('pointerdown', closeOnOutsidePointer, true);
  window.addEventListener('keydown', closeOnEsc, true);
  window.addEventListener('resize', updatePlacement, { passive: true });
  host.addEventListener(
    VIDEO_OVERLAY_DESTROY_EVENT,
    () => {
      if (resetLabelTimer !== undefined) window.clearTimeout(resetLabelTimer);
      if (idleTimer !== undefined) window.clearTimeout(idleTimer);
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      window.removeEventListener('keydown', closeOnEsc, true);
      window.removeEventListener('resize', updatePlacement);
    },
    { once: true },
  );
  window.requestAnimationFrame(() => {
    updatePlacement();
    void writeOverlayClientDiagnostics({
      state: 'created',
      defaultPosition: settings.defaultPosition,
      positionScope: settings.positionScope,
      placement: popover.dataset.placement,
      alignment: popover.dataset.align,
      rect: overlayRectSnapshot(host),
    });
  });

  return host;
}

function candidateName(c: OverlayCandidate, locale: ReturnType<typeof getDefaultLocale>): string {
  const raw =
    c.filename ||
    safeDisplayUrl(c.url, 60).replace(/^https?:\/\//, '') ||
    translate('videoOverlay.unknownName', locale);
  const withoutQuery = raw.split(/[?#]/, 1)[0] ?? raw;
  const base = withoutQuery.split(/[\\/]/).pop() ?? withoutQuery;
  const extension = candidateExtensionText(c, false);
  if (extension !== '\u2014') {
    const escaped = extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return base.replace(new RegExp(`\\.${escaped}$`, 'i'), '') || base;
  }
  return base;
}

function candidateExtensionText(c: OverlayCandidate, uppercase = true): string {
  const extension = normalizePickerExtension(
    c.extension ?? extensionHintFromUrl(c.url) ?? extensionFromMime(c.mimeType),
  );
  if (!extension) return '\u2014';
  return uppercase ? extension.toUpperCase() : extension;
}

function normalizePickerExtension(value?: string): string | undefined {
  const clean = value?.trim().replace(/^\.+/, '').toLowerCase();
  return clean || undefined;
}

function extensionFromMime(mimeType?: string): string | undefined {
  const mime = mimeType?.toLowerCase() ?? '';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('matroska')) return 'mkv';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('mpegurl')) return 'm3u8';
  if (mime.includes('dash+xml')) return 'mpd';
  return undefined;
}

function candidateSizeText(
  c: OverlayCandidate,
  locale: ReturnType<typeof getDefaultLocale>,
): string {
  if (typeof c.sizeBytes === 'number' && c.sizeBytes > 0) return formatBytes(c.sizeBytes);
  return translate('videoOverlay.unknownSize', locale);
}

function candidateResolutionText(c: OverlayCandidate): string {
  if (c.width && c.height) return `${c.width}\u00D7${c.height}`;
  if (c.height) return `${c.height}p`;
  const label =
    typeof c.metadata?.overlayQualityLabel === 'string' ? c.metadata.overlayQualityLabel : undefined;
  return label || '\u2014';
}

function candidateStableKey(c: OverlayCandidate): string {
  if (c.id?.startsWith('overlay-video-')) return c.id;
  return [
    canonicalPickerUrlKey(c.url),
    c.extension ?? '',
    c.sizeBytes ?? '',
    c.width ?? '',
    c.height ?? '',
    c.bitrate ?? '',
  ].join('|');
}

function canonicalPickerUrlKey(value: string): string {
  try {
    const parsed = new URL(value);
    const itag = parsed.searchParams.get('itag');
    const mime = parsed.searchParams.get('mime') ?? '';
    const clen = parsed.searchParams.get('clen') ?? '';
    if (itag)
      return `${parsed.hostname}${parsed.pathname}:itag=${itag}:mime=${mime}:clen=${clen}`;
    for (const volatile of [
      'expire',
      'ei',
      'ip',
      'ipbits',
      'ms',
      'mv',
      'mvi',
      'pl',
      'rn',
      'rbuf',
      'range',
      'ratebypass',
      'sig',
      'signature',
      'lsig',
      'n',
      'cver',
      'cpn',
    ]) {
      parsed.searchParams.delete(volatile);
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

function candidateListSignature(candidates: OverlayCandidate[]): string {
  return candidates.map(candidateStableKey).join('\n');
}

function isCandidateCacheStorageKey(key: string): boolean {
  return key.startsWith(CANDIDATE_CACHE_STORAGE_PREFIX) && key !== `${CANDIDATE_CACHE_STORAGE_PREFIX}index`;
}

function mergeOverlayCandidates(
  existing: OverlayCandidate[],
  fresh: OverlayCandidate[],
): OverlayCandidate[] {
  const byKey = new Map<string, OverlayCandidate>();
  for (const item of existing) byKey.set(candidateStableKey(item), item);
  for (const item of fresh) byKey.set(candidateStableKey(item), item);
  return [...byKey.values()].sort((a, b) => {
    const resolution = (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0);
    if (resolution !== 0) return resolution;
    const height = (b.height ?? 0) - (a.height ?? 0);
    if (height !== 0) return height;
    const size = (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
    if (size !== 0) return size;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
}

function openCandidatePicker(
  candidates: OverlayCandidate[],
  settings: OverlaySettings,
  anchor?: HTMLElement,
  returnFocusTo?: HTMLElement,
): void {
  destroyCandidatePickerHost(document.getElementById(PICKER_HOST_ID));
  if (!document.body) return;

  const locale = getDefaultLocale();
  const direction = getLocaleBundle(locale).direction;
  const titleText = translate('videoOverlay.pickerTitle', locale);
  const pickerTitleId = 'adm-picker-title';
  const sendText = translate('videoOverlay.sendSelected', locale);
  const closeText = translate('videoOverlay.close', locale);

  const host = document.createElement('div');
  host.id = PICKER_HOST_ID;
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.inset = 'auto auto auto auto';
  host.style.left = '40px';
  host.style.top = '40px';

  const shadow = host.attachShadow({ mode: 'open' });

  const root = document.createElement('div');
  root.className = 'adm-picker';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-labelledby', pickerTitleId);
  root.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'adm-picker-header';
  const titleEl = document.createElement('span');
  titleEl.id = pickerTitleId;
  titleEl.className = 'adm-picker-title';
  titleEl.textContent = titleText;
  const countEl = document.createElement('span');
  countEl.className = 'adm-picker-count';
  countEl.textContent = `(${candidates.length})`;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'adm-picker-close';
  closeBtn.setAttribute('aria-label', closeText);
  closeBtn.textContent = '\u00D7';
  header.append(titleEl, countEl, closeBtn);

  const toolbar = document.createElement('div');
  toolbar.className = 'adm-picker-toolbar';
  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'adm-picker-tool';
  selectAllBtn.textContent = translate('videoOverlay.selectAll', locale);
  const clearAllBtn = document.createElement('button');
  clearAllBtn.type = 'button';
  clearAllBtn.className = 'adm-picker-tool';
  clearAllBtn.textContent = translate('videoOverlay.clearSelection', locale);
  toolbar.append(selectAllBtn, clearAllBtn);

  const list = document.createElement('div');
  list.className = 'adm-picker-list';
  list.setAttribute('role', 'list');
  let pickerCandidates = mergeOverlayCandidates([], candidates);
  const selectedKeys = new Set<string>();
  const checkboxes: HTMLInputElement[] = [];
  let userTouchedSelection = false;

  function renderCandidateList(): void {
    list.textContent = '';
    checkboxes.length = 0;
    countEl.textContent = `(${pickerCandidates.length})`;
    for (const candidate of pickerCandidates) {
      const stableKey = candidateStableKey(candidate);
      const item = document.createElement('label');
      item.className = 'adm-picker-item';
      item.setAttribute('role', 'listitem');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked =
        selectedKeys.has(stableKey) ||
        (!userTouchedSelection && isCandidateSelectedByDefault(candidate, settings));
      checkbox.value = candidate.id;
      checkbox.dataset.stableKey = stableKey;
      if (checkbox.checked) selectedKeys.add(stableKey);
      checkboxes.push(checkbox);

      const main = document.createElement('div');
      main.className = 'adm-picker-item-main';
      const nameEl = document.createElement('div');
      nameEl.className = 'adm-picker-item-name';
      const displayName = candidateName(candidate, locale);
      nameEl.textContent = displayName;
      nameEl.title = displayName;
      const rowEl = document.createElement('div');
      rowEl.className = 'adm-picker-item-row';

      const extEl = document.createElement('span');
      extEl.className = 'adm-picker-field adm-picker-item-ext';
      extEl.textContent = candidateExtensionText(candidate);
      extEl.title = 'Extension';

      const sizeEl = document.createElement('span');
      sizeEl.className = 'adm-picker-field adm-picker-item-size';
      sizeEl.textContent = candidateSizeText(candidate, locale);
      sizeEl.title = 'Size';

      const resolutionEl = document.createElement('span');
      resolutionEl.className = 'adm-picker-field adm-picker-item-resolution';
      resolutionEl.textContent = candidateResolutionText(candidate);
      resolutionEl.title = 'Resolution';

      rowEl.append(extEl, sizeEl, resolutionEl);
      main.append(nameEl, rowEl);
      item.append(checkbox, main);
      list.append(item);
    }
  }

  const footer = document.createElement('div');
  footer.className = 'adm-picker-footer';
  const statusEl = document.createElement('span');
  statusEl.className = 'adm-picker-status';
  statusEl.textContent = '';
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'adm-picker-send';
  sendBtn.textContent = sendText;

  let refreshTimer: number | undefined;
  let refreshInFlight = false;
  let refreshQueued = false;
  let refreshGeneration = 0;
  let liveRefreshRounds = 0;
  let lastSignature = candidateListSignature(pickerCandidates);
  const pickerOpenedAt = Date.now();
  const liveBurstUntil = pickerOpenedAt + PICKER_LIVE_BURST_MS;
  const minLiveRefreshDelayMs = 120;

  function syncSelectedKeysFromCheckboxes(): void {
    selectedKeys.clear();
    for (const checkbox of checkboxes) {
      if (checkbox.checked && checkbox.dataset.stableKey) selectedKeys.add(checkbox.dataset.stableKey);
    }
  }

  function selectedIds(): string[] {
    return checkboxes.filter((c) => c.checked && !c.disabled).map((c) => c.value);
  }

  function closePicker(): void {
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    void writeOverlayClientDiagnostics({
      state: 'picker-closed',
      pickerSelected: selectedIds().length,
    });
    destroyCandidatePickerHost(host);
    returnFocusTo?.focus?.();
  }

  function updateSelectionStatus(): void {
    syncSelectedKeysFromCheckboxes();
    const selected = selectedIds().length;
    sendBtn.disabled = selected === 0;
    statusEl.textContent =
      selected > 0
        ? `${selected}/${checkboxes.length}`
        : translate('videoOverlay.noneSelected', locale);
  }

  closeBtn.addEventListener('click', closePicker);
  selectAllBtn.addEventListener('click', () => {
    userTouchedSelection = true;
    for (const checkbox of checkboxes) checkbox.checked = true;
    updateSelectionStatus();
  });
  clearAllBtn.addEventListener('click', () => {
    userTouchedSelection = true;
    for (const checkbox of checkboxes) checkbox.checked = false;
    updateSelectionStatus();
  });
  list.addEventListener('change', () => {
    userTouchedSelection = true;
    updateSelectionStatus();
  });

  const requestLiveRefresh = (reason: string, delayMs = minLiveRefreshDelayMs): void => {
    if (!settings.smartVideoContinuousRefresh) return;
    if (!document.getElementById(PICKER_HOST_ID)) return;
    if (reason === 'continuous-poll' && liveRefreshRounds >= PICKER_MAX_CONTINUOUS_REFRESH_ROUNDS)
      return;
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      void refreshPickerCandidates(reason);
    }, Math.max(0, delayMs));
  };

  const scheduleContinuousRefresh = (): void => {
    if (!settings.smartVideoContinuousRefresh) return;
    if (liveRefreshRounds >= PICKER_MAX_CONTINUOUS_REFRESH_ROUNDS) return;
    const burstDelay =
      Date.now() < liveBurstUntil
        ? Math.min(settings.smartVideoRefreshMs, 900)
        : Math.max(settings.smartVideoRefreshMs, PICKER_STEADY_REFRESH_MIN_MS);
    requestLiveRefresh('continuous-poll', burstDelay);
  };

  async function refreshPickerCandidates(reason = 'manual'): Promise<void> {
    refreshTimer = undefined;
    if (refreshInFlight || !document.getElementById(PICKER_HOST_ID)) {
      refreshQueued = refreshInFlight || refreshQueued;
      scheduleContinuousRefresh();
      return;
    }
    const generation = ++refreshGeneration;
    liveRefreshRounds += 1;
    refreshInFlight = true;
    try {
      const response = (await browser.runtime.sendMessage({ type: OVERLAY_REFRESH_MESSAGE_TYPE })) as
        | { ok?: boolean; candidates?: OverlayCandidate[]; capturedAt?: string }
        | undefined;
      const fresh = Array.isArray(response?.candidates) ? response!.candidates! : [];
      const merged = mergeOverlayCandidates(pickerCandidates, fresh);
      const nextSignature = candidateListSignature(merged);
      if (nextSignature !== lastSignature) {
        const previousCount = pickerCandidates.length;
        syncSelectedKeysFromCheckboxes();
        pickerCandidates = merged;
        lastSignature = nextSignature;
        renderCandidateList();
        updateSelectionStatus();
        positionCandidatePicker(host, anchor, settings.attachPickerToOverlay);
        const added = Math.max(0, pickerCandidates.length - previousCount);
        if (added > 0)
          statusEl.textContent = `+${added} \u2022 ${selectedIds().length}/${checkboxes.length}`;
        void writeOverlayClientDiagnostics({
          state: 'picker-refresh',
          reason,
          refreshGeneration: generation,
          refreshRounds: liveRefreshRounds,
          pickerItems: pickerCandidates.length,
          added,
          capturedAt: response?.capturedAt,
        });
      }
    } catch {
      // Keep the currently visible candidates; refresh is opportunistic.
    } finally {
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        requestLiveRefresh('queued-refresh', minLiveRefreshDelayMs);
      } else {
        scheduleContinuousRefresh();
      }
    }
  }

  sendBtn.addEventListener('click', async () => {
    const ids = selectedIds();
    if (ids.length === 0) {
      statusEl.textContent = translate('videoOverlay.noneSelected', locale);
      return;
    }
    sendBtn.disabled = true;
    statusEl.textContent = translate('videoOverlay.sending', locale);
    try {
      const result = (await browser.runtime.sendMessage({
        type: 'OVERLAY_SEND_SELECTED',
        candidateIds: ids,
      })) as { ok?: boolean; sent?: number } | undefined;
      if (result?.ok) {
        const sent = typeof result.sent === 'number' ? result.sent : ids.length;
        statusEl.textContent = `${translate('videoOverlay.sent', locale)} (${sent})`;
        window.setTimeout(closePicker, 1400);
      } else {
        throw new Error('rejected');
      }
    } catch {
      sendBtn.disabled = false;
      statusEl.textContent = translate('videoOverlay.sendFailed', locale);
    }
  });
  footer.append(statusEl, sendBtn);

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [
      ...shadow.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])'),
    ].filter((node) => !node.hasAttribute('disabled'));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && shadow.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && shadow.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  root.append(header, toolbar, list, footer);
  applyShadowStyles(shadow, pickerCss(direction, settings));
  shadow.append(root);
  makeDraggable(host, header, settings.attachPickerToOverlay ? anchor : undefined, settings);

  const closeOnEsc = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePicker();
  };
  const keepPickerInViewport = (): void =>
    positionCandidatePicker(host, anchor, settings.attachPickerToOverlay);
  const requestFromMediaEvent = (event: Event): void => {
    const target = event.target as Element | null;
    if (target && !target.closest?.('video,audio,source')) return;
    requestLiveRefresh(`media-${event.type}`, 80);
  };
  const requestFromStorageChange = (changes: Record<string, unknown>, areaName: string): void => {
    if (areaName !== 'local') return;
    if (Object.keys(changes).some(isCandidateCacheStorageKey)) requestLiveRefresh('candidate-cache-storage', 90);
  };
  const requestFromLiveEvent = (event: Event): void => {
    const reason =
      typeof (event as CustomEvent<{ reason?: unknown }>).detail?.reason === 'string'
        ? (event as CustomEvent<{ reason: string }>).detail.reason
        : 'live-event';
    requestLiveRefresh(reason, 70);
  };
  const pickerMutationObserver = new MutationObserver(() =>
    requestLiveRefresh('picker-dom-mutation', 140),
  );
  pickerMutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'src',
      'href',
      'data-src',
      'data-video',
      'data-video-src',
      'data-m3u8',
      'data-mpd',
      'data-manifest',
    ],
  });
  let performanceObserver: PerformanceObserver | undefined;
  try {
    performanceObserver = new PerformanceObserver((entries) => {
      if (entries.getEntries().some((entry) => isSmartVideoUrlHint(entry.name))) {
        requestLiveRefresh('performance-resource', 60);
      }
    });
    performanceObserver.observe({ entryTypes: ['resource'] });
  } catch {
    performanceObserver = undefined;
  }
  window.addEventListener('keydown', closeOnEsc, true);
  window.addEventListener('resize', keepPickerInViewport, { passive: true });
  window.addEventListener(VIDEO_OVERLAY_LIVE_REFRESH_EVENT, requestFromLiveEvent);
  browser.storage.onChanged.addListener(requestFromStorageChange);
  for (const eventName of ['loadedmetadata', 'durationchange', 'canplay', 'playing', 'progress']) {
    document.addEventListener(eventName, requestFromMediaEvent, true);
  }
  host.addEventListener(
    PICKER_DESTROY_EVENT,
    () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      pickerMutationObserver.disconnect();
      performanceObserver?.disconnect();
      browser.storage.onChanged.removeListener(requestFromStorageChange);
      window.removeEventListener('keydown', closeOnEsc, true);
      window.removeEventListener('resize', keepPickerInViewport);
      window.removeEventListener(VIDEO_OVERLAY_LIVE_REFRESH_EVENT, requestFromLiveEvent);
      for (const eventName of [
        'loadedmetadata',
        'durationchange',
        'canplay',
        'playing',
        'progress',
      ]) {
        document.removeEventListener(eventName, requestFromMediaEvent, true);
      }
    },
    { once: true },
  );

  renderCandidateList();
  document.body.append(host);
  positionCandidatePicker(host, anchor, settings.attachPickerToOverlay);
  updateSelectionStatus();
  requestLiveRefresh('picker-open-initial', 0);
  void writeOverlayClientDiagnostics({
    state: 'picker-open',
    pickerItems: candidates.length,
    pickerSelected: selectedIds().length,
    pickerRect: overlayRectSnapshot(host),
  });
  window.requestAnimationFrame(() => (checkboxes[0] ?? sendBtn).focus());
}

function isCandidateSelectedByDefault(
  candidate: OverlayCandidate,
  settings: OverlaySettings,
): boolean {
  if (settings.defaultPickerSelection === 'all') return true;
  if (settings.defaultPickerSelection === 'none') return false;
  const confidence =
    typeof candidate.confidence === 'number' ? candidate.confidence : settings.minConfidence;
  return confidence >= Math.max(20, settings.minConfidence);
}

function positionCandidatePicker(
  host: HTMLElement,
  anchor?: HTMLElement,
  attached = true,
): void {
  const margin = 12;
  const rect = host.getBoundingClientRect();
  const anchorRect = anchor?.getBoundingClientRect();
  const gap = attached && anchorRect ? 0 : 10;
  const preferredLeft = anchorRect ? anchorRect.right - rect.width : 40;
  const preferredTop = anchorRect ? anchorRect.bottom + gap : 40;
  const belowFits = !anchorRect || preferredTop + rect.height + margin <= window.innerHeight;
  const top = belowFits
    ? preferredTop
    : Math.max(margin, (anchorRect?.top ?? 40) - rect.height - gap);
  host.style.left = `${clamp(preferredLeft, margin, Math.max(margin, window.innerWidth - rect.width - margin))}px`;
  host.style.top = `${clamp(top, margin, Math.max(margin, window.innerHeight - rect.height - margin))}px`;
  host.style.right = 'auto';
  host.style.bottom = 'auto';
}

function makeDraggable(
  host: HTMLElement,
  handle: HTMLElement,
  linkedHost?: HTMLElement,
  linkedSettings?: OverlaySettings,
): void {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const moveTo = (clientX: number, clientY: number): void => {
    const rect = host.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const nextLeft = clamp(clientX - offsetX, margin, maxLeft);
    const nextTop = clamp(clientY - offsetY, margin, maxTop);
    const dx = nextLeft - rect.left;
    const dy = nextTop - rect.top;
    host.style.left = `${nextLeft}px`;
    host.style.top = `${nextTop}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    if (linkedHost && linkedSettings) {
      const linkedRect = linkedHost.getBoundingClientRect();
      applyAbsoluteOverlayPosition(linkedHost, linkedRect.left + dx, linkedRect.top + dy, linkedSettings);
    }
  };

  handle.addEventListener('pointerdown', (event) => {
    if ((event.target as Element | null)?.closest?.('.adm-picker-close')) return;
    const rect = host.getBoundingClientRect();
    dragging = true;
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    handle.setAttribute('data-dragging', 'true');
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    moveTo(event.clientX, event.clientY);
    event.preventDefault();
  });
  const stop = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    handle.removeAttribute('data-dragging');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    if (linkedHost && linkedSettings) void saveOverlayPosition(linkedHost, linkedSettings);
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

function makeVideoOverlayDraggable(
  host: HTMLElement,
  handle: HTMLElement,
  settings: OverlaySettings,
  onMove: () => void,
  onDraggedClickSuppressed: () => void,
): void {
  let tracking = false;
  let dragging = false;
  let pointerId: number | undefined;
  let offsetX = 0;
  let offsetY = 0;
  let startX = 0;
  let startY = 0;

  function moveTo(clientX: number, clientY: number): void {
    const rect = host.getBoundingClientRect();
    const maxLeft = Math.max(
      OVERLAY_EDGE_MARGIN,
      window.innerWidth - rect.width - OVERLAY_EDGE_MARGIN,
    );
    const maxTop = Math.max(
      OVERLAY_EDGE_MARGIN,
      window.innerHeight - rect.height - OVERLAY_EDGE_MARGIN,
    );
    const left = clamp(clientX - offsetX, OVERLAY_EDGE_MARGIN, maxLeft);
    const top = clamp(clientY - offsetY, OVERLAY_EDGE_MARGIN, maxTop);
    host.style.inset = 'auto auto auto auto';
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    onMove();
  }

  function snapIfNeeded(): void {
    if (!settings.snapToEdges) return;
    const rect = host.getBoundingClientRect();
    const left =
      rect.left + rect.width / 2 < window.innerWidth / 2
        ? OVERLAY_EDGE_MARGIN
        : window.innerWidth - rect.width - OVERLAY_EDGE_MARGIN;
    applyAbsoluteOverlayPosition(host, left, rect.top, settings);
    onMove();
  }

  handle.addEventListener('pointerdown', (event) => {
    if (
      (event.target as Element | null)?.closest?.(
        '.adm-video-download-label,.adm-video-download-close',
      )
    )
      return;
    const rect = host.getBoundingClientRect();
    tracking = true;
    dragging = false;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener('pointermove', (event) => {
    if (!tracking || pointerId !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - startX, event.clientY - startY);
    if (!dragging && moved < 4) return;
    dragging = true;
    handle.setAttribute('data-dragging', 'true');
    moveTo(event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  });

  function stopDragging(event: PointerEvent): void {
    if (!tracking || pointerId !== event.pointerId) return;
    tracking = false;
    pointerId = undefined;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    if (!dragging) return;
    dragging = false;
    handle.removeAttribute('data-dragging');
    snapIfNeeded();
    void saveOverlayPosition(host, settings);
    onDraggedClickSuppressed();
    event.preventDefault();
    event.stopPropagation();
  }

  handle.addEventListener('pointerup', stopDragging);
  handle.addEventListener('pointercancel', stopDragging);
}

export {
  applyShadowStyles,
  destroyVideoOverlayHost,
  destroyCandidatePickerHost,
  createVideoOverlayHost,
  openCandidatePicker,
  positionCandidatePicker,
};
