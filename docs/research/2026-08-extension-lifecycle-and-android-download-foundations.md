# Extension Lifecycle and Android Download Foundations

**Status:** Design research for the next bounded Android and extension reliability cycle.

## Browser extension findings

Chrome documents that extension contexts are distinct execution environments and that reloading an unpacked extension is treated as an update. Message passing is asynchronous and must tolerate a receiver or port becoming unavailable. The repair should therefore make every content-script call into extension-owned APIs fail closed when the context disappears, stop any local observer or retry work, and avoid reporting an expected update/reload condition as an uncaught application error. It must not suppress unrelated message failures.

The `ResizeObserver` specification guidance explains that the browser emits `ResizeObserver loop completed with undelivered notifications` when a callback makes cyclic layout changes. The appropriate remedy is to eliminate the self-triggering mutation where possible; where a post-layout update is necessary, defer it with `requestAnimationFrame`, coalesce repeat work, and disconnect during teardown. A global error listener is not a substitute for fixing the observer lifecycle.

## References

1. [Chrome Developers, `chrome.runtime`](https://developer.chrome.com/docs/extensions/reference/api/runtime)
2. [Chrome Developers, Message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
3. [MDN, `ResizeObserver` — Observation Errors](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver#observation_errors)

## Constraints

This cycle will preserve NOVA's existing security boundaries: content-script messages are treated as untrusted at privileged boundaries; no cookies, signed tokens, CAPTCHA/PO tokens, DRM controls, or access controls are harvested or bypassed. Browser reload/update recovery is user-visible only where an action needs to be repeated; otherwise it is silent and safely stops stale work.

## Android download and notification findings

Android supports app-initiated direct HTTP(S) downloads through `DownloadManager.Request`, including a controlled public Downloads destination, metered/roaming restrictions, charging and idle constraints, and system progress/completion-notification visibility. Its managed service is appropriate for an initial durable direct-link download implementation because it keeps the transfer alive outside the Compose activity. The application must present the selected URL and destination for review, validate HTTP(S) input, derive a safe file name, and query task status rather than claim segmented or media-extraction support before a common engine is packaged.

On Android 13 and newer, `POST_NOTIFICATIONS` is runtime-granted for ordinary notification delivery. A foreground service still requires a notification, but an app should request the permission in response to a clear user action and continue functioning without assuming it was granted. Android documents long-running workers and foreground service types separately; this cycle will use the platform download manager for direct downloads and retain the existing user-initiated-transfer boundary for a later shared-core implementation.

The supplied desktop log also identifies two correctness issues. Download creation logs must never include full signed query URLs because those values can be short-lived bearer-like credentials. The client should log a sanitized origin/path identity and a bounded error reason. In addition, expected request cancellation during changing UI state must not be retried or logged as a transient daemon failure; it should remain a silent, caller-visible cancellation.

## Additional references

4. [Android Developers, `DownloadManager.Request`](https://developer.android.com/reference/android/app/DownloadManager.Request)
5. [Android Developers, Support for long-running workers](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running)
6. [Android Developers, Notification runtime permission](https://developer.android.com/develop/ui/views/notifications/notification-permission)

## Proposed bounded milestone

The next implementation milestone will be limited to: a safe direct HTTP(S) input flow; platform-backed download enqueue and observable task state; download progress/completion notification configuration with a user-context notification permission request; lifecycle-safe extension messaging; narrow filtering of browser-generated `ResizeObserver` loop diagnostics after no NOVA observer was found; safe, useful client logging; and the two desktop error repairs. Theme choice, locale override, general permission centre, and rich scheduling will be designed against the same preferences boundary and delivered in subsequent bounded releases unless the reviewed code demonstrates an existing localized foundation that permits one of them without partial user-visible translations.
