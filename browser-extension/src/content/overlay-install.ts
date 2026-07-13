/* global EventListener, EventListenerOrEventListenerObject, AddEventListenerOptions */

import browser from 'webextension-polyfill';
import {
  SETTINGS_STORAGE_KEY,
  VIDEO_OVERLAY_DISCOVERY_SOURCE,
  VIDEO_OVERLAY_DISCOVERY_TYPE,
  VIDEO_OVERLAY_HOST_ID,
  VIDEO_OVERLAY_LIVE_REFRESH_EVENT,
  VIDEO_OVERLAY_RELAY_DATASET,
  VIDEO_OVERLAY_USER_CLOSE_EVENT,
} from './overlay-types';
import {
  hasOverlayCandidateHint,
  hasVideoCandidate,
  postVideoCandidateToTopFrame,
} from './overlay-detect';
import { readOverlaySettings, writeOverlayClientDiagnostics } from './overlay-position';
import { createVideoOverlayHost, destroyVideoOverlayHost } from './overlay-ui';

function installVideoDownloadOverlay(): void {
  if (window.top !== window) {
    installVideoCandidateRelay();
    return;
  }

  if (document.documentElement.dataset.novaVideoOverlayInstalled === 'true') return;
  document.documentElement.dataset.novaVideoOverlayInstalled = 'true';

  let closed = false;
  let creating = false;
  let frameReportedVideoCandidate = false;
  let scanTimer: number | undefined;
  let observer: MutationObserver | undefined;
  let mutationScanCount = 0;
  let disposed = false;

  const listenersToRemove: Array<{
    target: EventTarget;
    type: string;
    handler: EventListenerOrEventListenerObject;
    options?: AddEventListenerOptions;
  }> = [];
  let storageChangeListenerRegistered = false;

  function addTrackedListener(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    listenersToRemove.push({ target, type, handler, options });
  }

  function removeAllTrackedListeners(): void {
    for (const { target, type, handler, options } of listenersToRemove) {
      target.removeEventListener(type, handler, options);
    }
    listenersToRemove.length = 0;
    if (storageChangeListenerRegistered) {
      browser.storage.onChanged.removeListener(storageChangeHandler);
      storageChangeListenerRegistered = false;
    }
  }

  function disposeOverlay(): void {
    if (disposed) return;
    disposed = true;
    closed = true;
    removeAllTrackedListeners();
    observer?.disconnect();
    if (scanTimer !== undefined) {
      window.clearTimeout(scanTimer);
      scanTimer = undefined;
    }
    const host = document.getElementById(VIDEO_OVERLAY_HOST_ID);
    if (host) destroyVideoOverlayHost(host);
  }

  const show = (): void => {
    if (!disposed) void maybeShow();
  };

  const maybeShow = async (): Promise<void> => {
    if (closed || creating || disposed || document.getElementById(VIDEO_OVERLAY_HOST_ID) || !document.body)
      return;
    creating = true;
    try {
      const overlaySettings = await readOverlaySettings();
      if (!overlaySettings.enabled) {
        void writeOverlayClientDiagnostics({ state: 'hidden', hiddenReason: 'disabled' });
        return;
      }
      if (overlaySettings.showOnlyWhenCandidates && !frameReportedVideoCandidate) {
        const hintFound = overlaySettings.hideWhenFiltersRejectAll
          ? hasOverlayCandidateHint(overlaySettings)
          : hasVideoCandidate();
        if (!hintFound) {
          void writeOverlayClientDiagnostics({
            state: 'hidden',
            hiddenReason: overlaySettings.hideWhenFiltersRejectAll
              ? 'no-filtered-hints'
              : 'no-hints',
          });
          return;
        }
      }
      const host = await createVideoOverlayHost(overlaySettings);
      host.addEventListener(VIDEO_OVERLAY_USER_CLOSE_EVENT, () => {
        closed = true;
        destroyVideoOverlayHost(host);
        observer?.disconnect();
        if (scanTimer !== undefined) window.clearTimeout(scanTimer);
      });
      if (!document.getElementById(VIDEO_OVERLAY_HOST_ID) && document.body) {
        document.body.append(host);
        observer?.disconnect();
      }
    } finally {
      creating = false;
    }
  };

  const scheduleScan = () => {
    if (closed || disposed || scanTimer !== undefined || document.getElementById(VIDEO_OVERLAY_HOST_ID))
      return;
    mutationScanCount += 1;
    if (mutationScanCount > 160) {
      observer?.disconnect();
      void writeOverlayClientDiagnostics({
        state: 'observer-paused',
        hiddenReason: 'mutation-budget-exhausted',
      });
      return;
    }
    scanTimer = window.setTimeout(
      () => {
        scanTimer = undefined;
        show();
      },
      Math.min(1200, 350 + Math.floor(mutationScanCount / 20) * 100),
    );
  };

  addTrackedListener(
    window,
    'message',
    ((event: MessageEvent) => {
      if (event.source === window) return;
      const data = event.data as { source?: unknown; type?: unknown } | undefined;
      if (
        data?.source === VIDEO_OVERLAY_DISCOVERY_SOURCE &&
        data.type === VIDEO_OVERLAY_DISCOVERY_TYPE
      ) {
        frameReportedVideoCandidate = true;
        show();
      }
    }) as EventListener,
  );

  const showFromLiveDiscovery = (): void => {
    frameReportedVideoCandidate = true;
    show();
  };
  addTrackedListener(window, VIDEO_OVERLAY_LIVE_REFRESH_EVENT, showFromLiveDiscovery as EventListener);
  for (const eventName of ['loadedmetadata', 'canplay', 'playing', 'durationchange']) {
    addTrackedListener(document, eventName, showFromLiveDiscovery as EventListener, {
      capture: true,
    });
  }

  // Track resolution/presentation changes on video elements
  const videoResizeHandler = (event: Event): void => {
    const video = event.target as HTMLVideoElement | null;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    frameReportedVideoCandidate = true;
    show();
  };
  for (const eventName of ['resize', 'ratechange', 'loadedmetadata']) {
    addTrackedListener(document, eventName, videoResizeHandler as EventListener, { capture: true });
  }

  addTrackedListener(window, 'beforeunload', disposeOverlay as EventListener);
  addTrackedListener(window, 'pagehide', disposeOverlay as EventListener);

  function storageChangeHandler(changes: Record<string, unknown>, areaName: string): void {
    if (areaName !== 'local' || !changes[SETTINGS_STORAGE_KEY]) return;
    mutationScanCount = 0;
    closed = false;
    const host = document.getElementById(VIDEO_OVERLAY_HOST_ID);
    if (host) destroyVideoOverlayHost(host);
    if (!closed && observer && document.documentElement) {
      observer.disconnect();
      observer.observe(document.documentElement, {
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
          'data-m3u8-url',
          'data-hls',
          'data-hls-url',
          'data-mpd',
          'data-mpd-url',
          'data-dash',
          'data-dash-url',
          'data-manifest',
          'data-master',
          'poster',
        ],
      });
    }
    show();
  }
  browser.storage.onChanged.addListener(storageChangeHandler);
  storageChangeListenerRegistered = true;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', show, { once: true });
  } else {
    show();
  }

  observer = new MutationObserver(scheduleScan);
  const startObserver = () => {
    if (!document.body || closed || disposed) return;
    observer?.observe(document.documentElement, {
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
        'data-m3u8-url',
        'data-hls',
        'data-hls-url',
        'data-mpd',
        'data-mpd-url',
        'data-dash',
        'data-dash-url',
        'data-manifest',
        'data-master',
        'poster',
      ],
    });
    scheduleScan();
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  else startObserver();
}

function installVideoCandidateRelay(): void {
  if (document.documentElement.dataset[VIDEO_OVERLAY_RELAY_DATASET] === 'true') return;
  document.documentElement.dataset[VIDEO_OVERLAY_RELAY_DATASET] = 'true';

  let reported = false;
  let scanTimer: number | undefined;
  let observer: MutationObserver | undefined;
  let relayScanCount = 0;
  let disposed = false;

  function cleanup(): void {
    if (disposed) return;
    disposed = true;
    if (scanTimer !== undefined) {
      window.clearTimeout(scanTimer);
      scanTimer = undefined;
    }
    observer?.disconnect();
    observer = undefined;
  }

  const reportIfFound = () => {
    scanTimer = undefined;
    if (reported || disposed || !hasVideoCandidate()) return;
    reported = true;
    postVideoCandidateToTopFrame();
    cleanup();
  };

  const scheduleScan = () => {
    if (reported || disposed || scanTimer !== undefined) return;
    relayScanCount += 1;
    if (relayScanCount > 120) {
      cleanup();
      return;
    }
    scanTimer = window.setTimeout(reportIfFound, 240);
  };

  window.addEventListener('beforeunload', cleanup, { once: true });
  window.addEventListener('pagehide', cleanup, { once: true });

  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  if (hasVideoCandidate()) postVideoCandidateToTopFrame();
}

export { installVideoDownloadOverlay, installVideoCandidateRelay };
