# Browser Media Reliability Cycle — September 2026

## Research scope

This bounded cycle focuses on the browser extension's media-analysis path, especially YouTube page handling, overlay messaging, candidate freshness, and user-facing failure states. It does not promise permanent compatibility with any media site and does not introduce DRM bypass, CAPTCHA/access-control bypass, cookie harvesting, credential export, signed-URL manufacture, or raw extractor diagnostics in the UI.

## Findings from primary documentation

Chrome documents that content scripts can access only a restricted set of extension APIs and should communicate with background contexts through runtime messaging; privileged APIs such as downloads are indirect from content scripts. Chrome also documents that asynchronous one-time responses must keep the message channel open with a literal `true` for the callback form, and that message payloads use JSON serialization. These constraints support keeping analysis and final task creation in the trusted background/bridge path rather than accepting candidate URLs directly from a page.

Chrome's content-script documentation distinguishes static, dynamic, and programmatic injection, and notes that `activeTab` or host permissions are required for programmatic injection. It also describes isolated worlds, which prevent page JavaScript variables from being treated as extension state. This supports treating page DOM observations as untrusted hints and binding analysis to the browser-owned tab URL and current page state.

Chrome's downloads API exposes lifecycle state, resumability, danger classification, filename, final URL, byte counts, and interruption reasons. The extension should use those states for clear progress and completion feedback, while avoiding display or persistence of sensitive transient delivery URLs. The API's `filename` is an absolute local path and should not be surfaced to web content without an explicit user-facing action mediated by the desktop application.

Firefox's WebExtensions documentation likewise describes content scripts as limited API clients that communicate with background scripts, and notes restricted browser domains and special pages where content scripts cannot run. It also notes that content scripts do not run by default in `about:blank`, `srcdoc`, `data:`, or `blob:` pages unless related-frame behavior is explicitly enabled. These are compatibility boundaries that should map to a localized, actionable unsupported-page state rather than a generic no-formats message.

## yt-dlp and mature-project patterns

The yt-dlp project documents selector-based format selection and explains that some services, notably YouTube, may expose separate audio and video formats. Its FAQ and issue guidance emphasize keeping yt-dlp current and using verbose diagnostics when reporting extractor failures. NOVA should keep such diagnostics in controlled local logs and map them to bounded localized outcomes in the extension; it should not expose raw stderr, URLs, headers, cookies, or tokens to page content.

The open-source AB Download Manager ecosystem and related browser-integration projects demonstrate a useful separation between browser capture and desktop-manager execution: the extension detects a user-initiated download or media candidate, while the desktop manager owns the actual task and lifecycle. The practical UX pattern is explicit handoff, clear candidate state, retry/recheck controls, and a visible distinction between “page analyzed”, “candidate available”, “handoff accepted”, and “download completed”. NOVA should adopt the state separation without copying code or claiming support for protected streams.

## Bounded implementation direction

The highest-value low-risk improvements for this cycle are: make overlay state transitions explicit; clear stale candidate lists at the beginning of every analysis; keep only candidates that satisfy the current bounded contract; provide localized retry and tool-readiness guidance; bind re-analysis to the top-level browser tab URL; and retain background re-analysis before task creation. A focused regression suite should cover stale-selection rejection, iframe/top-level URL mismatch, extension-context invalidation during teardown, missing formats, tool-unavailable outcomes, and translation parity.

The next implementation must preserve the existing trusted-sender policy and must not revive the legacy generic probe path for new UI flows. Any compatibility change must be measurable through unit tests, extension production builds, and the existing Playwright suite.

## References

1. [Chrome for Developers — Message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
2. [Chrome for Developers — Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
3. [Chrome for Developers — chrome.downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
4. [MDN — Content scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)
5. [yt-dlp — GitHub repository and documentation](https://github.com/yt-dlp/yt-dlp)
6. [yt-dlp — FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ)
7. [AB Download Manager — GitHub repository](https://github.com/amir1376/ab-download-manager)
8. [AB Download Manager browser integration — GitHub repository](https://github.com/amir1376/ab-download-manager-browser-integration)
9. [Media Downloader browser extension — GitHub repository](https://github.com/rtcoder/Media-downloader)
10. [Quantum Download Manager — GitHub repository](https://github.com/PBhadoo/QDM)
