# Browser Media Reliability and UX Research — September 2026

## Initial official findings

### Chrome content scripts

Chrome documents that content scripts can directly use only a limited subset of extension APIs, including runtime messaging, storage, and i18n; privileged APIs must be reached indirectly through the background context. Content scripts run in an isolated world, and static or dynamic injection has explicit lifecycle and matching semantics. This supports keeping download control, tab ownership, URL validation, and privileged browser APIs in the background router rather than trusting page code.

Source: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts

### Chrome downloads API

The official downloads API exposes persistent download IDs, state changes, pause/resume capability, byte counters, total bytes, final URL, filename, danger status, and interruption errors. Chrome notes that file-existence checks can be stale and that `search()` does not wait for the filesystem check; completion and interruption handling should therefore be driven by download events and refreshed item state rather than assuming a single callback is authoritative.

Source: https://developer.chrome.com/docs/extensions/reference/api/downloads

### MDN WebExtensions

MDN confirms that content scripts communicate with background scripts to access privileged APIs, that dynamic scripts may persist across browser restarts unless explicitly registered as non-persistent, and that restricted pages and special schemes can prevent injection. The extension should treat context invalidation, unavailable tabs, and unsupported URLs as expected state transitions with user-facing recovery rather than uncaught errors.

Source: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts

### MDN examples

The MDN maintained examples repository includes complete examples for latest-download handling, page-to-extension messaging, session state, user-script registration, dynamic content-script registration, i18n notifications, and native messaging. These examples are useful reference patterns for isolating background responsibilities and testing cross-browser behavior.

Source: https://github.com/mdn/webextensions-examples

## Research implications for NOVA

1. Keep YouTube analysis and download initiation in the background/desktop bridge; content scripts should send bounded intents and display state.
2. Treat extension-context invalidation as a recoverable lifecycle state and stop timers, observers, ports, and pending UI writes when the context is gone.
3. Correlate browser download events by persistent download ID and refresh the item before rendering completion actions; do not rely on filename or one event alone.
4. Make unsupported page schemes, frames, stale tabs, and protected media explicit states in the UI.
5. Keep localized state labels and notification titles in the shared extension locale contract.
6. Use a compact, state-driven video panel: resolve, show quality catalog, hand off, observe queued/active/complete/interrupted, then offer open-file/open-location actions only when the browser confirms the file state.

## Safety boundary

NOVA must not bypass DRM, authentication, cookies, access controls, CAPTCHAs, signed tokens, or regional restrictions. Improvements should target allowed media analysis, browser lifecycle reliability, transparent error states, and safe handoff to the local NOVA service.

## References

- [1] [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [2] [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
- [3] [MDN WebExtensions content scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)
- [4] [MDN WebExtensions examples](https://github.com/mdn/webextensions-examples)

## Comparative product findings

### Motrix

Motrix presents a clean desktop experience around a download engine separated from the UI and built on aria2, with support for HTTP, FTP, BitTorrent, magnet links, and cross-platform packaging. The useful design lesson for NOVA is to preserve a stable engine contract while allowing the UI to evolve independently, and to expose advanced controls without making the primary task flow complex.

Source: https://motrix.app/about/

### aria2

aria2 demonstrates the value of a lightweight multi-protocol engine with multi-connection downloads, Metalink verification, and JSON-RPC/XML-RPC remote control. For NOVA, this supports explicit engine capability reporting, resumable state, bounded concurrency settings, integrity-aware metadata, and a transport contract that does not leak privileged request material into the extension.

Source: https://aria2.github.io/

### JDownloader

JDownloader emphasizes start/stop/pause controls, bandwidth limits, automatic archive extraction, and extensibility. The relevant UX pattern is a consistent task lifecycle with obvious controls and post-download actions rather than a single disposable progress dialog.

Source: https://jdownloader.org/

### Video DownloadHelper

Video DownloadHelper emphasizes automatic detection, a visible ready state when media is found, broad format support including MP4/HLS/DASH/audio, privacy messaging, and clear separation between simple use and advanced processing. NOVA should adopt the clear detected/ready/resolving/handed-off states while remaining explicit that protected or unavailable media cannot be downloaded.

Source: https://downloadhelper.net/

## Candidate improvements for the next bounded release

| Area | Candidate change | Success measure |
|---|---|---|
| Context lifecycle | Add a shared safe-runtime guard for content-script timers, observers, and message calls after extension reload/update. | No uncaught `Extension context invalidated` from the guarded paths; regression tests cover disposed contexts. |
| YouTube resolve flow | Add request identity and cancellation/stale-response protection to the floating panel and router. | A late response cannot overwrite a newer page snapshot or selected quality. |
| Download state | Correlate browser download events with refreshed download items and expose deterministic states for queued, active, paused, interrupted, and complete. | Tests cover duplicate events, stale filename events, resumable interruption, and completion action availability. |
| UX | Replace ambiguous video-panel actions with a compact state machine and localized status copy. | Every state has one primary action, an accessible live-region message, and no black/empty transient surface. |
| Engine handoff | Return bounded capability and error categories from NOVA rather than raw yt-dlp output. | No raw URLs, cookies, headers, tokens, or process diagnostics cross the extension UI boundary. |
| UI responsiveness | Use container-aware layout rules and overflow-safe quality rows for narrow popup and panel sizes. | Visual/unit checks confirm no clipped controls at configured compact widths. |
| Power features | Surface advanced options only after a user opens an advanced section: bandwidth, connections, scheduling, and post-actions. | Primary flow remains one-step while advanced preferences persist and remain localized. |

## Additional references

- [5] [Motrix official about page](https://motrix.app/about/)
- [6] [aria2 official project page](https://aria2.github.io/)
- [7] [JDownloader official homepage](https://jdownloader.org/)
- [8] [Video DownloadHelper official homepage](https://downloadhelper.net/)
