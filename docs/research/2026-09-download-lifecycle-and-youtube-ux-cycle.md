# Download Lifecycle and YouTube UX Research — September 2026

## Scope

This cycle targets reliability of the browser extension when the Manifest V3 service worker is restarted, better truthful download lifecycle presentation, and a modern media-analysis experience for YouTube and other supported video pages. The scope excludes DRM bypass, authentication extraction, cookie harvesting, CAPTCHA bypass, protected-media controls, and direct exposure of transient extractor URLs.

## Evidence and decisions

### 1. Treat the service worker as ephemeral

Chrome documents that extension service workers can be terminated after inactivity and that global variables are lost. Persistent state should be stored in extension storage, while event handlers should be resilient to unexpected termination. [1]

**Decision for NOVA:** keep download tracking in bounded `storage.local`, restore state before registering lifecycle listeners, and keep the browser-owned `DownloadItem` as the source of truth. Persist only redacted metadata required for truthful notifications.

### 2. Keep storage bounded and asynchronous

Chrome documents asynchronous bulk reads and writes, storage quotas, and the distinction between local, session, sync, and managed areas. `storage.local` is appropriate for per-machine state, while storage writes must account for quota and latency. [2]

**Decision for NOVA:** cap persisted tracked-download records, sanitize filenames, reject unknown notice states, avoid URLs and sensitive headers, and tolerate storage failures without taking down the background router.

### 3. Use browser download state rather than event ordering

The downloads API exposes a persistent download ID, `state`, `paused`, `canResume`, `bytesReceived`, `totalBytes`, and interruption information. `canResume` explicitly covers interrupted downloads that can continue from the existing position. [3]

**Decision for NOVA:** classify completion, resumable pause/interruption, and terminal failure from a refreshed `DownloadItem` after a delta. De-duplicate notifications per download ID and remove tracking only after a terminal state.

### 4. Make modern UX reflect actual capability

Gopeed presents task recovery, pause/resume/retry, filtering, responsive layouts, browser integration, localization, and automation as first-class product capabilities. [4]

**Decision for NOVA:** show actionable states only when the current format or browser download can be acted upon. Keep the floating panel responsive, clear stale quality snapshots before re-analysis, and localize all user-visible states.

### 5. Keep yt-dlp readiness explicit and safe

The yt-dlp project publishes ongoing releases and extractor maintenance through its public repository and release channel. [5]

**Decision for NOVA:** report bounded readiness categories such as tool unavailable, timeout, process failure, invalid output, and oversized output. Never surface extractor stderr, cookies, authorization headers, or transient delivery URLs to the page.

## Bounded implementation target

This cycle will implement one measurable reliability slice: durable browser-download tracking across service-worker restarts, with a bounded sanitized store, refreshed browser state classification, and regression tests for restore, invalid records, capacity, and terminal lifecycle behavior. UI changes remain limited to truthful state presentation and responsive media-panel behavior.

## References

[1]: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle — Chrome extension service worker lifecycle.
[2]: https://developer.chrome.com/docs/extensions/reference/api/storage — Chrome storage API and quotas.
[3]: https://developer.chrome.com/docs/extensions/reference/api/downloads — Chrome downloads API and DownloadItem lifecycle fields.
[4]: https://github.com/GopeedLab/gopeed — Gopeed open-source download manager and browser integration reference.
[5]: https://github.com/yt-dlp/yt-dlp/releases — yt-dlp release and extractor maintenance channel.
