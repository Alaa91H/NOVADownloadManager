# Extension overlay and Android core review

**Date:** 2026-08-27
**Scope:** Bounded reliability review for the browser-extension media overlay, external FFmpeg validation, and the Android transfer foundation.

## Findings

The extension has two materially different media-analysis paths. The popup sends the stable page URL to the authenticated `POST /v1/analyze` endpoint and receives an explicit `analysisCode` when the engine cannot return a safe format catalog. The floating video panel instead calls the older `GET /api/ytdlp/probe` endpoint and reduces any no-format or non-success result to a generic English toast. This explains why the panel can report “No downloadable formats found” without identifying whether the local tool is unavailable, analysis timed out, extractor output was invalid, the source is protected, or no ordinary downloadable format exists.

Chrome permits extensions to observe request lifecycles but response/transport visibility is bounded by granted host permissions and cache behavior. It does not make protected or session-gated media intrinsically downloadable. The corrected panel must use the same browser-to-NOVA analysis contract as the popup, expose only bounded diagnostic categories, and retain the stable page URL rather than forwarding a short-lived delivery URL. [1]

The browser downloads API supports HTTP(S) download requests and a `uniquify` file-conflict policy, but its browser-specific failure strings are not stable API contracts. NOVA should use its structured bridge/daemon result for diagnostics rather than parse browser error text. [2]

The prior FFmpeg adjustment accepts a nightly `N-<build>-g<commit>` identifier. A real observed build also adds a timestamp suffix, `N-126277-ga8c7afa7d7-20260826`. The parser therefore needs to accept only an optional eight-digit build date after a valid hexadecimal commit, while rejecting arbitrary suffixes. The build still has to pass the existing executable and integrity checks.

Android uses Android `DownloadManager` for real ordinary HTTP(S) transfers. The bounded implementation replaces the dormant lifecycle stub with a NOVA-owned local task core that safely records only Android task identifiers and display names, restores task state after the activity is recreated, and reconciles the catalog from its declared transfer lifecycle service. Network transfer and its progress/complete notification remain Android `DownloadManager` responsibilities. This is a functioning local NOVA task core over the platform engine, not a packaged shared Rust core or an independent segmented HTTP engine.

## Decisions for this bounded cycle

| Area | Decision | Boundary |
|---|---|---|
| Floating overlay | Move probing to the authenticated unified analysis contract and display bounded result categories with actionable, localized UI text. | Do not capture cookies, authorization headers, signed URL parameters, or raw extractor stderr. |
| Candidate handling | Keep normal candidate filters; when media is visible but no direct candidate exists, offer only the stable-page NOVA analysis route. | Do not claim every embedded player yields a downloadable file. |
| FFmpeg | Permit `N-<decimal>-g<hex>(-<YYYYMMDD>)?` nightly identifiers. | Retain rejection of malformed banners and existing verified-installation controls. |
| Android core | Implement a local NOVA task catalog with durable task identifiers, safe filename handling, restore/reconciliation, and Android notification lifecycle via the system transfer engine. | Normal HTTP(S) files only; no Rust-core claim, DRM removal, account bypass, cookie/token extraction, CAPTCHA/PO-token bypass, or media-site circumvention. |

## References

[1]: https://developer.chrome.com/docs/extensions/reference/api/webRequest "Chrome webRequest API"
[2]: https://developer.chrome.com/docs/extensions/reference/api/downloads "Chrome downloads API"
[3]: https://github.com/yt-dlp/yt-dlp#format-selection "yt-dlp format selection and dependencies"
