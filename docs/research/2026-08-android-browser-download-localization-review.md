# Android Browser, Download, DNS, and Localization Review

**Date:** 2026-08-27
**Scope:** NOVA Android companion evolution after `v2.4.38-alpha`

## Decision summary

The current Android module is a small Compose companion, not yet a complete Android download engine. Its next release should therefore establish reliable foundations rather than claim feature parity with mature download managers. The highest-confidence delivery is a **safe embedded browsing and link-intake foundation**, a release-only APK pipeline, a generated Android localization catalog, and explicit policy boundaries around protected media.

| Capability requested | Evidence-based decision for NOVA | Boundary |
| --- | --- | --- |
| In-app browser and download capture | Use Android `WebView` with a `WebViewClient`, `DownloadListener`, navigation state, and explicit user handoff into NOVA’s download-review queue. | Capture only ordinary HTTP(S) downloads that the page exposes to the browser; preserve referring-page context only with user review and do not expose cookies or credentials. |
| Clean browsing | Enable Safe Browsing, prevent unsolicited popups, block a small maintained set of known advertising/tracker hosts, and surface an allow-list escape hatch. | Do not silently substitute traffic through a third-party proxy or weaken TLS. A full rule-list engine must be license- and update-reviewed before inclusion. |
| DNS providers and custom DNS | Provide a validated **DNS-over-HTTPS profile model** and readiness checks for documented provider endpoints. | A WebView cannot safely be made to use a custom resolver by merely storing a setting. System-wide/per-app routing requires `VpnService`, explicit Android consent, foreground-service disclosure, and a packet tunnel; this is a later, separately audited capability. |
| Browser user scripts | Support saved, user-controlled page scripts that run only after explicit enablement and only on a matching top-level HTTPS origin. | No Android JavaScript bridge, privileged native APIs, cross-frame injection, cookie export, DRM bypass, CAPTCHA circumvention, or arbitrary background/network privileges. |
| DRM | Detect and clearly reject protected-media download attempts. | NOVA does not disable, bypass, or work around DRM, subscriptions, login requirements, regional restrictions, or access controls. |
| Android languages | Generate Android string resources from NOVA’s validated desktop locale dictionaries and use Android’s resource model and system language configuration. | Release only when every Android-visible key is present for every supported desktop locale; fallback English is never presented as a completed translation. |
| APK distribution | Build and stage one release APK for end users, never a debug APK. | Android’s release artifact must be signed by a persistent release signing identity; an ephemeral/generated key is unsuitable because it would break update continuity. |

## Research findings

Android’s `WebView` is a suitable embedded web renderer, but it is not a full browser by default. It offers a `DownloadListener` for content that the renderer cannot handle, navigation handling through `WebViewClient`, and JavaScript through `WebSettings`. The Android documentation also recommends blocking popups by leaving `WebChromeClient.onCreateWindow` unimplemented and requires explicit destruction of unused WebViews to avoid retaining native memory.[1]

> Android warns that `addJavascriptInterface()` exposes a supplied object to every frame and can let untrusted page content control Android code. The NOVA design therefore uses `evaluateJavascript()` only for isolated, user-saved snippets and **does not create a native JavaScript bridge**.[1] [2]

Safe Browsing should remain enabled. Android recommends that setting and describes recovery after a renderer process termination: the failed WebView must be removed and destroyed, then a new instance created rather than reusing the failed renderer.[3] This recovery path is directly relevant to the reported Android stability issue.

The mature Android download managers reviewed publicly advertise link sharing/clipboard intake, multi-part transfers, paused-download resumption, background work, per-file controls, browsing with tabs/history/bookmarks, and notifications.[4] [5] Those provide a roadmap, not a claim of present NOVA capabilities. Notably, 1DM’s own public listing states that downloading from YouTube is not supported because of that platform’s terms; NOVA likewise must not frame media capture as a way to bypass platform restrictions.[4]

For DNS, Cloudflare describes DoH as DNS queries carried inside HTTPS, while Quad9 documents its threat-blocking DoH endpoint as `https://dns.quad9.net/dns-query`.[6] [7] Android’s supported mechanism that can route an app through a custom DNS path is a `VpnService`, which requires explicit system permission, a visible active-connection experience, foreground-service behavior, and packet processing through a TUN interface.[8] It is intentionally not introduced as a superficial settings switch in this cycle.

The desktop application already validates every key in each of its 132 language dictionaries. Android documentation confirms that all visible UI text should be resources rather than hard-coded strings, that incomplete default resources can cause a force-close on unsupported locales, and that per-app language preferences can be generated from resource directories on Android 13+.[9] [10] The current Android module has only `values/strings.xml` plus hard-coded English Compose text, which is both a parity gap and a plausible locale-specific stability risk.

The `v2.4.38-alpha` CI workflow builds both variants but stages `app-debug.apk` as the public Android release asset. Android’s own build guidance states that debug artifacts are signed with an insecure debug key, whereas release artifacts intended for distribution need an appropriate private release key.[11] The next pipeline must stage only the signed release asset and verify it with `apksigner`.

## Implementation order

| Priority | Delivery | Acceptance evidence |
| --- | --- | --- |
| P0 | Replace public debug APK staging with release-only staging and signing verification; add an Android activity-launch smoke test to CI on an emulator-capable runner. | CI refuses unsigned or debug-signed staged APK; launch smoke test completes. |
| P0 | Remove Android hard-coded UI text, add resource-backed localized strings, Android locale configuration, and parity validation against the desktop catalog. | Build-time parity check has no missing key/language; language and RTL tests pass. |
| P0 | Add a recoverable app-start shell that records a non-sensitive initialization state and keeps first render independent of optional native/browser initialization. | Activity smoke test and unit tests prove fallback behavior. |
| P1 | Add a memory-safe single-tab browser foundation with navigation, download detection, user-confirmed link intake, Safe Browsing, controlled popup policy, history persistence, and renderer recovery. | Unit tests cover URL policy, download handoff metadata, blocked schemes, and recovery state. |
| P1 | Add managed user scripts: local storage, opt-in switch, host match validation, size limit, top-frame-only execution, no native bridge, and audit-friendly execution status. | Unit tests reject unsafe patterns and ensure disabled scripts never execute. |
| P2 | Add an audited DNS privacy feature only after a per-app `VpnService` implementation, consent UX, resolver integration tests, battery/network failure handling, and a privacy disclosure. | TUN, consent, routing, and resolver tests pass on real device/emulator. |
| P2 | Migrate durable transfer semantics from the shared Rust core behind the typed FFI boundary, then progressively add multipart, queue, notifications, resumption, storage categorization, and import. | Real transfer lifecycle tests validate byte preservation, restart recovery, and user-visible controls. |

## References

[1]: https://developer.android.com/develop/ui/views/layout/webapps/webview "Build web apps in WebView — Android Developers"
[2]: https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges "WebView native bridges — Android Developers"
[3]: https://developer.android.com/develop/ui/views/layout/webapps/managing-webview "Manage WebView objects — Android Developers"
[4]: https://play.google.com/store/apps/details?id=idm.internet.download.manager&hl=en_US "1DM: Browser & Video Download — Google Play"
[5]: https://play.google.com/store/apps/details?id=com.dv.adm&hl=en_US "Advanced Download Manager — Google Play"
[6]: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/ "DNS over HTTPS — Cloudflare"
[7]: https://docs.quad9.net/services/ "Services — Quad9 Documentation"
[8]: https://developer.android.com/develop/connectivity/vpn "VPN — Android Developers"
[9]: https://developer.android.com/guide/topics/resources/localization "Localize your app — Android Developers"
[10]: https://developer.android.com/guide/topics/resources/app-languages "Per-app language preferences — Android Developers"
[11]: https://developer.android.com/build/building-cmdline "Build your app from the command line — Android Developers"
