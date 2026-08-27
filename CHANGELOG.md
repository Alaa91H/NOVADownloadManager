# Changelog

All notable changes to NOVA Download Manager are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.42-alpha] - 2026-08-27

### Fixed

- **Restored the floating browser video panel as a constrained, functional NOVA workflow.** Its Download action now uses the same authenticated `/v1/analyze` contract as the extension popup rather than the retired generic yt-dlp probe. The panel receives bounded analysis outcomes, never treats an empty catalog as a successful result, and displays existing localized feedback instead of the opaque “No downloadable formats found” failure.
- **Bound the overlay to its real browser tab.** A content-panel analysis derives the current HTTP(S) page from its trusted sender, not from a page-provided URL. Selecting a quality submits only its format identifier; the background re-analyses the stable page and verifies that the format is still present before requesting the daemon-owned media task. Expiring delivery URLs, cookies, headers, and raw extractor output never cross this boundary.
- **Accepted dated official FFmpeg nightly identifiers.** Health checks now accept `N-<build>-g<commit>-<YYYYMMDD>` only when its build, hexadecimal commit, and eight-digit date are valid. Malformed banners and arbitrary suffixes remain rejected, resolving the observed FFmpeg installation failure without weakening executable or checksum verification.

### Added

- **Added a durable local NOVA Android task catalog.** Android now persists only accepted platform-download IDs and safe display names, restores them when the activity is recreated, and reconciles them through its declared user-initiated-transfer lifecycle service. This makes direct HTTP(S) transfers and their live Android notifications materially observable after an app restart without persisting source URLs, request headers, tokens, or cookies.
- **Added regression coverage for the enabled overlay boundary.** Router tests now prove that overlay scan/analyze/send messages require a trusted HTTP(S) content-script sender and a real tab, bind work to cached or freshly analysed data, and continue to obey the configured rate limit.

### Scope and safety

- This alpha's Android task core is a NOVA-owned catalog and lifecycle layer over Android `DownloadManager`; it is not a packaged Rust core, a standalone segmented HTTP engine, or a guarantee of every site's media availability. Ordinary HTTP(S) downloads remain the supported Android transfer class.
- NOVA does not remove DRM, bypass access controls, account requirements, CAPTCHAs, PO tokens, regional restrictions, or media-site protections. Protected or unavailable media remains unavailable for managed download.

## [2.4.41-alpha] - 2026-08-27

### Fixed

- **Restored the independent Android foundation and CodeQL Java/Kotlin checks.** Release-signing enforcement is now evaluated only when a release Gradle task is requested, so debug-only CI and fork-safe CodeQL compilation no longer require release secrets. The primary distribution workflow retains its explicit secret checks and signed-release APK verification. The affected workflows now use `android-actions/setup-android@v4`.
- **Made desktop destination conflicts diagnosable before a transfer starts.** The native file writer now rejects a destination that is a directory and a parent path component that is a file, replacing the generic Windows “file already exists” creation failure with a direct corrective message. It never creates through, overwrites, or reinterprets an existing file as a folder.
- **Stopped signed direct-download URLs from being written to the desktop application log.** Task creation records the HTTP(S) origin only and preserves a bounded daemon error summary, preventing query tokens, URL fragments, paths, and embedded credentials from appearing in exported logs. Expected request cancellation is no longer retried as a transient request failure.
- **Accepted valid FFmpeg nightly version identifiers.** The verified external-tool health check recognises the strict official `N-<build>-g<commit>` format as a compatible FFmpeg snapshot while continuing to reject malformed or non-numeric executable banners.
- **Hardened browser-extension reload behavior.** Content scripts now remove listeners, observers, timers, and the floating UI when their WXT context is invalidated. Runtime messages made by an old context fail safely, and only the browser-defined `ResizeObserver` loop diagnostic is suppressed; unrelated page and extension errors remain visible for diagnosis.

### Added

- **Added a functional Android direct-download foundation.** The Android app now accepts an explicit HTTP(S) link, validates it before enqueueing, derives a safe file name, and hands the transfer to Android’s platform download manager under the user-visible `Downloads/NOVA` location. The task list polls the system service for queued, active, paused, completed, and failed state.
- **Added Android download progress and completion notification handling.** Platform download notifications are enabled for accepted transfers. On Android 13 and later, NOVA asks for notification permission only in response to the user pressing the download action; a declined permission does not fabricate failure or prevent the system-managed transfer from being tracked in the app.
- **Added focused regression coverage.** New tests cover destination-file conflicts, signed URL log redaction, FFmpeg stable/nightly/invalid version parsing, extension lifecycle diagnostics, and Android direct-link intake with a ready or unavailable repository.

### Scope and safety

- Android direct downloads in this alpha use the platform `DownloadManager` for ordinary HTTP(S) files. This bounded milestone does not claim a packaged shared Rust segmented engine, media-site extraction, DRM disabling, cookie/token export, CAPTCHA/PO-token bypass, or access-control circumvention.
- The next Android milestones are deliberately separate: a fully localized theme and language preference implementation, an explicit permission-center screen, and a durable, configurable scheduler with Android power/network constraints. They will be shipped only after their resources and platform behavior are testable across the maintained locale set.

## [2.4.40-alpha] - 2026-08-27

### Fixed

- **Made managed YouTube analysis single-flight in the browser extension.** Rapid repeat clicks on the compact resolve action now produce one local-engine analysis request, render an accessible busy state, and keep the interaction available again when the request settles.
- **Stopped transient YouTube delivery URLs from being analyzed when no stable page URL exists.** A detected `googlevideo`/`videoplayback` URL without a trusted watch, Shorts, live, embed, short-link, or playlist page is not passed to the managed engine or the browser downloader. The popup now exposes the localized failure state directly in its compact surface instead of silently retaining it behind a closed list.
- **Made empty managed-media analysis results truthful.** The daemon now returns a bounded analysis category for unavailable, timed-out, failed, oversized, or invalid yt-dlp output without leaking process stderr or URL context. The popup keeps user-visible messaging localized and never presents an empty catalog as a successful quality resolution.

### Security and reliability

- **Added a protected-media handoff guard.** The extension carries the explicit `drmProtected` result from managed analysis into the selected-format request, and the daemon rejects a marked protected-media request before task creation. This is a defensive UI-to-daemon boundary; NOVA does not disable or bypass DRM, service restrictions, cookies, tokens, CAPTCHAs, account requirements, or geographic controls.
- **Improved compact popup feedback.** Status notifications now announce through a polite live region and remain visible when a resolve action fails before the candidate dropdown opens. Busy controls share one action state to avoid conflicting scan, send, and analyze operations in the constrained popup surface.
- **Documented the technical decision.** The review records yt-dlp update/FFmpeg guidance, YouTube restrictions, Chrome download state handling, and the selected privacy-preserving implementation boundary.

### Quality

- Added regression coverage for duplicate YouTube resolve clicks, missing stable page URLs, managed DRM flags, visible compact failure feedback, and the daemon's protected-media request marker. The full browser-extension suite continues to cover capture, transport, policy, and formatting behavior.

## [2.4.39-alpha] - 2026-08-27

### Fixed

- **Reduced Android cold-start risk.** Removed an unused custom `Application`/WorkManager startup path and its stale release-shrinker rules. The launcher now reaches a compact Compose shell with a safe fallback for restored navigation state, while the Android transfer-job service remains isolated from UI startup.
- **Stopped publishing a debug APK as the Android release asset.** Android CI now builds JVM-tested debug code for development validation but stages only `app-release.apk` after `apksigner` verification. Release signing is supplied solely through GitHub Actions secrets; no keystore, password, or key material is committed.

### Added

- **Added a lightweight in-app Android browser foundation.** It accepts normal HTTP(S) pages only, rejects local/intent/JavaScript URL schemes and credential-bearing navigation, enables Android Safe Browsing, disables multiple-window popups, and captures ordinary browser download callbacks into NOVA's explicit download-review path. Captured link displays redact query and fragment data while preserving the original value internally for future transfer execution.
- **Added clean-browsing controls with a small deterministic tracker/ad host blocklist.** The feature is local, opt-out, and applies only to the integrated browser; it does not inspect other apps or change device-wide network traffic. A terminated WebView renderer is recreated safely rather than terminating the host application.
- **Added constrained user-script support for the integrated browser.** Scripts are disabled by default, stored locally, limited to eight entries and 64 KB each, and run only after a user opt-in on an explicitly matching top-level HTTPS host. NOVA exposes no native JavaScript bridge, Android API, cookies, download queue, or cross-tab privilege to these scripts.
- **Added Android locale generation and enforcement from NOVA's existing catalog.** Android now carries resource bundles for all 132 maintained NOVA languages and 49 Android-visible catalog strings. The generator and validator fail when a language or mapped resource is absent, preserving Android RTL/resource qualification support without adding an English-only partial locale.
- **Added DNS privacy-profile foundations.** The Android settings model contains system, Cloudflare, Google, Quad9, AdGuard, and validated custom DNS-over-HTTPS endpoints as local preferences. It intentionally does not alter device DNS, run a VPN, or claim to route WebView traffic until a separately consented private-routing implementation exists.

### Security and scope

- NOVA does not disable or bypass DRM, access controls, account requirements, geographic restrictions, or protected-media playback. The Android browser forwards only ordinary HTTP(S) download callbacks for user review; protected or service-controlled media remains outside this implementation.
- Android's shared Rust transfer bridge is packaged but has not yet been connected to the Compose intake path in this bounded milestone. The UI therefore remains truthful when an actual transfer cannot be submitted instead of fabricating a successful download.
- The browser test environment could not complete a software-rendered emulator boot without hardware acceleration. This release validates Android JVM tests, resource compilation, release shrinking, APK signing, and package contents; it does not claim a physical-device or booted-emulator launch result.

## [2.4.38-alpha] - 2026-08-27

### Fixed

- **Made verified external-tool installation resilient to GitHub API throttling.** The managed yt-dlp/FFmpeg release lookup now uses GitHub's current public API media-type/version headers and caches successful metadata for a bounded 15 minutes. Settings rendering no longer performs a release-metadata request, so routine refreshes cannot exhaust the public API budget.
- **Stopped update-check failures from looking like success.** Provider, compatibility, and rate-limit failures now travel through the native and frontend contracts as an explicit indeterminate result. Settings reports the actual error rather than incorrectly announcing that an unavailable tool is up to date, and installation returns that diagnostic when no verified candidate can be resolved.
- **Serialized tool actions in the Settings UI.** While an install, update, discovery, health check, path change, or uninstall is pending for a tool, competing actions for that same tool are disabled and the card exposes an accessible busy state. This prevents conflicting lifecycle calls before activation and health verification finish.

### User experience and responsive layout

- **Prevented controls from being clipped in constrained windows.** The shared modal now caps itself to the live viewport and keeps its content scrollable; drag bounds use the available viewport instead of a fixed status-bar estimate. The Settings navigator becomes a horizontally scrollable tab row on narrow widths, while its content remains reachable.
- **Made the desktop media workflow responsive.** The Media Download page stacks its former fixed 55/45 column split below the desktop breakpoint, allows action groups and output presets to wrap, and preserves a two-column, independently scrollable layout when space is available. This keeps the YouTube URL input, engine state, format choices, and final action within the visible workspace.
- **Removed the global button rule that prohibited shrink and wrapping.** Individual compact controls can still opt into fixed sizing, but generic action rows now adapt to their container rather than overflowing it.

### Security, verification, and scope

- The installer still accepts only trusted HTTPS release assets, requires a published SHA-256 digest, validates the staged executable before activation, installs atomically, and never embeds a GitHub credential in user-device code. It does not bypass DRM, account restrictions, regional availability, or content permissions.
- Added regression coverage for busy external-tool action states and for provider failure reporting. Updated browser-status, localization, and time-display integration assertions to target the stable application status bar instead of an optional transient notification. Added native coverage for bounded cache expiry. The isolated live yt-dlp installer acceptance check now completes download, SHA-256 verification, executable health validation, registration, and cleanup successfully.
- This is a bounded reliability and responsive-layout release. It does not claim a complete redesign of every screen or a guarantee that third-party media sites will remain compatible as their services change.

## [2.4.37-alpha] - 2026-08-27

### Fixed

- **Routed YouTube captures through NOVA's managed media workflow.** The browser-extension popup now resolves a stable YouTube watch, Shorts, live, embed, short-link, or playlist page through the local engine before a format is queued. It no longer treats transient `googlevideo`/`videoplayback` delivery URLs as ordinary direct browser downloads.
- **Restored a visible, actionable YouTube flow when initial capture is empty.** A trusted popup scan now receives its page URL as well as captured candidates. On a supported YouTube page, the compact popup presents the existing localized “Resolve via NOVA” action even when the generic scan has not produced a direct media candidate.
- **Made managed-media success daemon-authoritative.** The selected format remains retryable when NOVA rejects it. The popup reports success and marks a format sent only after the local engine returns `accepted: true`.

### User experience and localization

- Opening a YouTube format now expands the popup into the already-available analysis and format-selection view, rather than leaving the result hidden in collapsed state. The selected format carries the engine-returned format identifier while the stable page URL remains the task source.
- Replaced hard-coded labels in the analyzed-format panel, quality table, and dense candidate actions with existing extension translation keys. No partial or English-only locale keys were added.

### Quality and scope

- Added regression coverage for stable-page resolution with and without generic candidates, the absence of `DOWNLOAD_DIRECT` on the YouTube route, accepted and rejected managed-media additions, and the popup scan page-URL contract. Existing YouTube-adapter and message-router coverage remains in the focused suite.
- This improvement does not manufacture or export cookies, bypass DRM or access controls, or expose authorization data. The local media engine remains responsible for current yt-dlp/FFmpeg availability, supported content, download execution, and merge behavior.

## [2.4.36-alpha] - 2026-08-27

### Fixed

- **Made Batch Import single-submit and daemon-aware.** The import action now enters an accessible busy state immediately, rejects repeat clicks while the batch is being submitted, and waits for the local engine to finish accepting tasks before leaving the page.
- **Kept failed batches actionable.** Batch creation now returns attempted and accepted counts to the UI. When the engine accepts no task, NOVA remains on Batch Import and restores the action instead of navigating to Downloads as if the import had succeeded.

### Reliability and accessibility

- **Preserved existing intake safety boundaries.** URL-pattern expansion remains capped, direct-protocol capability checks and exact intra-batch deduplication still happen before submission, and no URL is canonicalized, exposed, or altered by the submission-lifecycle fix.
- Reused the established localized batch placeholder rather than introducing a new hard-coded guide string. The submit control exposes `aria-busy` while it is awaiting the engine response.

### Quality

- Added page-level coverage for in-flight duplicate-click prevention, delayed navigation, zero-acceptance handling, and unsupported-batch rejection. Extended task-store coverage for attempted/accepted result counts, blank entries, and zero-success batches.
- Documented the bounded research review of JDownloader, Persepolis, and AB Download Manager batch/link intake practices. The improvement deliberately focuses on reliable collection-to-queue transition rather than adding an unreviewed crawler or altering signed URLs.

## [2.4.35-alpha] - 2026-08-27

### Added

- **Added an exact-URL duplicate warning to Add Download.** When the submitted URL is already represented by a NOVA task, the dialog shows a compact non-blocking warning before the user queues or starts another copy. Intentional repeats remain available: neither action is disabled and the original submitted URL is passed through unchanged.
- **Made duplicate-link warnings configurable.** The existing localized “Show duplicate warning before downloading” preference is now active in Downloads settings. It is enabled by default for existing and new configurations, while an explicit user opt-out is preserved.

### Privacy and reliability

- **Kept duplicate matching deliberately literal.** NOVA compares the raw submitted URL after input whitespace is trimmed; it does not remove or normalize paths, credentials, query parameters, fragments, or case. This prevents different signed or authenticated URLs from being incorrectly conflated and ensures the warning itself never renders a sensitive URL.
- **Preserved the separation between URL intake and output-file conflict policy.** The new warning concerns an existing task URL only. It neither changes the chosen output path nor overrides the native rename, overwrite, skip, or resume policy for an on-disk filename collision.

### Quality

- Added unit coverage for exact matching, empty/malformed inputs, signed-URL distinction, and non-normalization; dialog coverage for safe warning display, query privacy, distinct tokens, and intentional repeat queueing; and settings-merge coverage for default migration and saved opt-out behavior.
- Stabilized the modal backdrop Playwright contract by waiting for the component's deliberate 50 ms outside-press guard before simulating the event. This tests the actual interaction boundary rather than racing the opening-click protection.
- Documented the intake-boundary rationale using JDownloader, Free Download Manager, and AB Download Manager research. The change is deliberately scoped to transparent, user-controlled direct-download intake rather than automatic crawler or clipboard behavior.

## [2.4.34-alpha] - 2026-08-27

### Added

- **Exposed daemon-backed download profiles in the Scheduler speed workspace.** Users can now select the engine's available policy profile, including the built-in Maximum Speed, Balanced, Economical, and Background profiles, from a compact accessible control. The active profile's daemon-provided description remains visible with the selection.

### Fixed

- **Rejected profile switches no longer look successful in the frontend state layer.** A false `ok` response from the engine now rejects the activation operation, preserving the server-authoritative active selection and showing an accessible failure state instead of silently refreshing as though the switch worked.

### Reliability and scope

- **Kept policy selection separate from scheduler list limits.** A profile selects the native engine policy for connections, adaptive behavior, retry behavior, segmentation, and its optional rate cap. The existing scheduler list speed limiter remains a distinct time-window rule and is not overwritten by the profile selector.
- Normalized daemon-supplied profile metadata before display, dropping malformed or duplicate entries, constraining display text, and never allowing an unknown active identifier to become a selectable value.

### Quality

- Added unit coverage for malformed profile metadata, duplicate suppression, display normalization, active-profile membership, successful selection, rejected selection, and the existing list-speed-limiter path.
- Documented the comparative rationale from Free Download Manager, Motrix Next, and aria2: user-facing traffic modes should be understandable policy choices while concurrency, per-item connections, and explicit speed limits remain independently scoped.

## [2.4.33-alpha] - 2026-08-26

### Added

- **Added a safe source-inspection summary to Add Download.** After NOVA completes its staged URL probe, the dialog now exposes the HTTP response status, normalized MIME type, byte-range capability, server-advertised SHA-256 digest, redirect origins, and RFC 6249 duplicate-link mirror count when those values are available.

### Security and reliability

- **Kept signed redirect details out of the UI.** Redirect inspection renders origins only; credentials, paths, query parameters, and fragments are deliberately removed before presentation.
- **Preserved native integrity enforcement.** The new summary reports a server-provided SHA-256 only as technical metadata. NOVA's native curl transfer path remains responsible for validating an advertised Content-Digest against the completed output.

### Quality

- Added focused unit and dialog tests for probe-summary derivation, redirect sanitization, malformed metadata rejection, and lifecycle visibility.
- Documented a comparative review of aria2, JDownloader, Free Download Manager, and Persepolis to keep the improvement scoped to a proven reliability pattern rather than adding speculative protocol support.

## [2.4.32-alpha] - 2026-08-26

### Fixed

- **Made the Settings sound-selection E2E path independent of translated text.** The test now selects the stable Downloads-tab identifier instead of a partial English accessible name that became ambiguous after the localized labels `General & Downloads` and `All Downloads` were introduced. This restores the release-tag Playwright gate without changing the product control.

### Quality

- Re-ran the three affected Playwright sound-selection scenarios locally against the integration daemon and Vite application; all passed.

## [2.4.31-alpha] - 2026-08-26

### Fixed

- **Stopped healthy, quiet download event streams from being treated as stale.** The daemon's SSE keep-alive comments are not surfaced as browser message events, so NOVA no longer synthesizes an error and reconnects merely because no download payload arrived during an idle period.
- **Restored normal reconciliation polling after a real SSE reconnection.** A successful stream open now clears the temporary fallback state, preventing a recovered connection from remaining on unnecessary high-frequency polling.
- **Localized the complete Settings navigation list.** The side navigation now renders established catalog keys rather than hard-coded English labels; the Arabic list, including the application-log label, is fully Arabic.
- **Hardened Windows configuration replacement and recovery.** When a destination config already exists, the Windows-specific writer retains a recoverable `.bak` copy while promoting the new file, and startup can read that backup if an interruption leaves the primary file absent. This is a durable recovery-oriented replacement path rather than a claim of atomic NTFS replacement.

### Quality

- Added regression coverage for an idle SSE stream, a genuine-error reconnect, connection callbacks after reconnect, and the localized Arabic Settings navigation.
- Added native coverage for reading a recovery backup when `config.json` is temporarily absent. Local validation passed 487 frontend tests, 741 Rust tests with one ignored, Rust Clippy, production build/audits, and Android debug/release/JVM builds.

## [2.4.30-alpha] - 2026-08-26

### Changed

- **Expanded localized UI coverage across the maintained language catalog.** Previously hard-coded labels, buttons, tooltips, logging controls, browser controls, media settings, column controls, speed controls, and DNS/proxy settings now use shared translation keys.
- **Reworked About into a localized maintainer contact and support panel.** It exposes direct GitHub, email, Telegram, and Ko-fi links through NOVA's existing external-link bridge.
- **Rewrote the public README and added a product-scope guide.** The documentation now distinguishes implemented capabilities from runtime, remote-server, browser, and external-tool constraints, and includes the maintainer's support channels.
- **Unified Android launcher artwork with NOVA's primary branding source.** The branding generator now creates density-specific Android mipmap icons, which the Android Manifest uses for normal and round launcher icons.

### Fixed

- **Hardened Android startup against stale saved navigation state.** An unknown restored destination now falls back to Downloads instead of throwing during Compose composition and closing the application.
- **Restored the Android release-build configuration.** The missing project R8/ProGuard rules file is now present, and explicitly preserves Manifest-instantiated entry points during release shrinking.
- **Updated Android CI to `android-actions/setup-android@v4`,** removing the Node 20 deprecation warning by using the action's Node 24 migration.

### Quality

- The primary Android CI job now builds both the installable debug APK and a release APK before it stages the debug APK release asset, catching release-only minification/configuration regressions.
- Validated all 132 interface dictionaries at 1,317 keys each, passed the full frontend test suite, TypeScript, ESLint, production build, documentation-fact check, installer audit, Android debug/release builds, and Android JVM tests locally.
- Physical-device and emulator launch validation remain unclaimed because no Android device or emulator was available in this environment. The release retains diagnostics for any device-specific startup report.

## [2.4.29-alpha] - 2026-08-26

### Changed

- **The compact multi-connection progress strip now shows only its coloured transfer cells.** Per-connection percentage pills were removed from the narrow strip, while overall progress, accessible segment labels, hover details, and expanded segment cards retain their progress information.

### Fixed

- **Paused partial downloads are now treated as owned resume checkpoints rather than duplicate-file conflicts.** When the duplicate policy is set to rename, NOVA preserves the original partial output path and resumes it with HTTP Range instead of renaming it to a new file and restarting at byte zero.
- **A resumable partial output now remains on its matching single-file transfer path** if a later preflight would otherwise promote the task to a new segmented layout, preventing previously downloaded bytes from being ignored.
- **User-initiated pauses now persist their final task and segment checkpoint immediately** once the worker stops, reducing the chance of losing resumable state if NOVA is closed immediately afterwards.

### Quality

- Added regression coverage for a no-clobber partial checkpoint resuming in place and for the actual user pause/resume API on a multi-connection transfer.
- Updated progress-dialog tests to require a clean multi-connection strip with no visible percentage badges while retaining accessible progress text.

## [2.4.28-alpha] - 2026-08-26

### Changed

- **Browser extension pages now launch their target browser directly on Windows.**
  The former `cmd /C start` relay was removed so opening Chrome, Edge, or Firefox
  extension management no longer flashes a black command window.
- **Completed downloads now show an actionable completion dialog instead of
  leaving the progress window on a `Finished` action.** The dialog displays the
  saved file, offers **Open File** and **Open File Location**, and provides a
  persistent **Do not show this completion window again** option. The preference
  can be re-enabled from **Settings → After Download Completes**.
- **The primary CI workflow now builds an ARM64 Android debug APK after building
  the Rust bridge and publishes that `.apk` as a tagged-release asset.** Android
  APK packaging is a release-readiness gate rather than a separate tag workflow.
- **GitHub releases now contain installable packages and `SHA256SUMS.txt` only.**
  Scoop, Homebrew, and Winget metadata files are no longer uploaded as release
  assets.

### Quality

- Added automated coverage for the completion dialog's file actions, opt-out
  persistence, completion-dialog queueing, and direct browser-launch mapping.
- Extended release-asset policy verification to require the Android APK and to
  reject non-installable package-manager metadata from the final manifest.

## [2.4.27-alpha] - 2026-08-26

### Fixed

- **Windows FFmpeg installation now selects BtbN's static archive rather than a
  shared archive.** NOVA extracts and validates a standalone `ffmpeg.exe`, so
  Windows no longer fails to start the managed tool because companion
  `av*.dll` files from a shared build were absent.
- **Managed external-tool installation now refreshes its in-memory registry
  before the post-install health check.** This prevents a successfully saved
  `yt-dlp` installation from being misreported as unhealthy until the daemon
  restarts.
- **The completed-download `Finished` control is now a real button.** It is
  keyboard accessible and dismisses the completed progress dialog instead of
  rendering as a non-interactive status label.

### Quality

- Added regression coverage that rejects shared FFmpeg Windows archives and
  verifies that `Finished` is enabled and dismisses a completed progress dialog.

## [2.4.26-alpha] - 2026-08-26

### Added

- **Introduced a buildable native Android foundation.** The new Kotlin + Jetpack
  Compose + Material 3 client includes adaptive navigation, a centralized NOVA
  theme and Material Symbol mapping, immutable `StateFlow` UI state, and a
  repository boundary that explicitly prevents a second Kotlin download engine.
- Added validated `ACTION_SEND` text sharing for the first HTTP(S) URL in shared
  content. Links are surfaced for review only; no Android task is fabricated
  until the typed Rust task contract exists.
- Added a versioned UniFFI bridge handshake and a reproducible NDK-backed
  `arm64-v8a` build script for the narrow Rust mobile bridge.
- Added Android build, bridge, background-execution, storage, media, testing,
  architecture, and feature-parity documentation, including explicit platform
  limitations and device-validation gates.

### Changed

- Extracted the portable `Task` and `Segment` schemas into `nova-core-model` and
  made the desktop daemon consume those shared records through a local Rust
  dependency, preserving the existing serialized field behavior.
- Normalized direct-download origin keys through libcurl's URL API before they
  reach adaptive profiling or connection leasing. Equivalent origins now share
  a stable host-and-port identity, including IPv6 literals.

### Fixed

- **Release version stamping now honors a tag passed through pnpm.** The script
  ignores pnpm's `--` separator instead of falling back to an older local tag,
  preventing accidental version rollback during release preparation.
- Propagated ordinary preflight range detection into adaptive transfer metadata.
  Servers that return `206 Partial Content` now seed the profile with the same
  range capability that the dispatcher uses to select segmented transfers.

### Security

- Removed URL user-info, paths, queries, and fragments from adaptive host keys.
  This prevents credentials embedded in a direct URL from entering connection
  leases or adaptive profiling identifiers.
- Android share input accepts HTTP(S) links only, and the design establishes a
  typed in-process bridge with an API-version compatibility check rather than a
  desktop loopback control plane.
- Android storage and diagnostics designs use capability-scoped destinations and
  require redaction of headers, tokens, persisted URI grants, and private paths.

### Quality

- Added loopback range-preflight coverage and origin-key regression tests for
  credentials, query and fragment stripping, explicit ports, malformed URLs,
  and IPv6 formatting.
- Added a checksum-pinned Gradle 9.5.0 Wrapper, AGP 9 built-in Kotlin migration,
  JVM tests for shared-link validation and ViewModel state, and a dedicated
  Android CI workflow for the debug APK, JVM tests, and ARM64 bridge-link proof.
- Verified the Android debug APK/JVM test build and local ARM64 native-link
  proof. Android runtime loading, real downloads, background work, SAF/MediaStore,
  emulator testing, and physical-device testing remain intentionally unclaimed.

## [2.4.25-alpha] - 2026-08-25

### Added

- **Batch imports now skip exact duplicate concrete URLs before queueing.**
  URL-pattern expansion keeps the first occurrence in input order and reports
  how many repeated requests were omitted, preventing redundant transfers
  without canonicalizing signed or case-sensitive URLs.

### Quality

- Added regression tests for first-seen ordering and exact-match handling of
  signed and case-sensitive URLs in batch deduplication.

## [2.4.24-alpha] - 2026-08-25

### Fixed

- **Windows MSI packaging now accepts alpha and beta release tags.** Tauri bundle
  metadata converts a semantic prerelease label to its equivalent numeric
  prerelease identifier, as required by WiX/MSI, while the application and
  browser-extension packages retain the full user-facing semantic version.
- **Linux CI dependency installation now retries safely after mirror rotation.**
  A bounded helper refreshes stale APT indexes and retries package downloads,
  preventing transient Ubuntu archive 404 responses from failing ARM64 builds.
- **Windows NSIS installers are now always staged as release assets.** The
  packaging workflow no longer filters executable filenames against the
  user-facing alpha tag, which differs intentionally from the MSI-compatible
  numeric prerelease used by Tauri.

### Quality

- Version stamping now derives the distinct package, browser-manifest, and
  Tauri bundle representations for prerelease releases, preventing an invalid
  installer version from reaching the platform build matrix.

## [2.4.23-alpha] - 2026-08-25

### Fixed

- **External-tool PATH discovery now ignores non-executable shadow files.** A
  regular file without executable permission can no longer prevent NOVA from
  finding a valid `yt-dlp` or FFmpeg binary in a later PATH directory. This
  avoids false-negative tool health checks and makes managed tool activation
  more reliable on Unix-like systems.

### Fixed

- **Production Tauri builds now load the verified native libcurl environment.**
  The build command passes the generated prefix, package metadata, and static
  pkg-config settings directly to Tauri, avoiding accidental fallback to an
  incomplete system libcurl link line.
- **Local packaging no longer rolls back the declared version to an older Git
  tag.** Version stamping remains an explicit release operation, while the
  build command consistently honors the versions already present in the source
  manifests.
- **Linux AppImage retries start from a clean generated staging directory.**
  This prevents stale GTK-plugin symlinks from a failed linuxdeploy run from
  contaminating a subsequent packaging attempt; the tool is also run in its
  supported extraction mode where FUSE is unavailable.

### Quality

- Added an isolated Rust regression test that proves PATH resolution skips a
  non-executable candidate and selects the subsequent executable candidate
  without mutating the process-wide PATH.
- Synchronized the desktop application, Rust package, Tauri configuration,
  browser extension, and extension manifest at `2.4.23-alpha`.

## [2.4.22-alpha] - 2026-08-22

### Fixed

- **Native libcurl is now selected consistently by Rust/Tauri builds.** The
  generated build environment exposes the freshly built `curl-config`, so
  `curl-sys` retains the audited native prefix instead of falling back to a
  vendored library with a different capability profile.
- **Linux PIE linking is reliable.** The static native curl archive is built
  with position-independent code, allowing the daemon and Tauri application to
  link successfully as modern PIE executables.
- **AppImage release verification is complete.** The Linux packaging path has
  been verified end to end for DEB, RPM, and AppImage output using the
  repository's declared `patchelf` build dependency.
- **Extension release checks inspect the correct artifact.** The extension CI
  now produces the Chromium store build before evaluating store-readiness,
  preventing ordinary development artifacts from being mistaken for a
  store-ready package.
- **Release-tag Playwright validation now provisions Tauri's Linux build
  dependencies.** This gives the integration daemon access to the required
  GTK/GObject development metadata before browser E2E tests start, preventing
  release verification from failing on a clean runner.
- **Cold release runners receive a realistic daemon startup allowance.** The
  integration health check now waits long enough for the first Rust/Tauri build
  before declaring browser E2E startup unsuccessful.

### Security

- **Browser extension CSP no longer admits arbitrary loopback ports.** The
  policy enumerates only the transport's documented failover origins on
  `127.0.0.1` and `localhost` for ports `3199` through `3208`, for both HTTP
  and WebSocket connections. Source-policy and runtime checks now prevent a
  wildcard regression.

### Quality

- Extension popup end-to-end coverage now asserts the intentional idle state
  when no media context is available, while retaining a measurable popup shell
  and matching the release-readiness contract.

## [2.4.21-alpha]

### Added

- **Managed external-tool installation scopes.** Settings now offer the
  recommended per-user NOVA-managed location and, on Windows, an explicit
  `Program Files` option that requests administrator approval only after the
  downloaded binary has passed digest and health validation.
- A live, opt-in yt-dlp acceptance test that downloads the official release,
  verifies its published SHA-256 digest, installs it atomically, and executes
  its version check. The check is ignored by the regular offline-friendly Rust
  suite and is run explicitly in release verification.
- `scripts/verify_real_extension_handoff.sh`, which verifies a real integration
  daemon's ping, trusted pairing, bearer authentication, and candidate handoff
  contract.
- Root `LICENSE` (MIT) and `THIRD_PARTY_NOTICES.md` documenting bundled
  curl/libcurl, yt-dlp, and FFmpeg license obligations.
- Repository-standard governance files: `SECURITY.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, and this `CHANGELOG.md`.
- License and third-party notices are staged into the installed application
  directory at build time (`scripts/build-tauri-assets.mjs`) and asserted by the
  final source audit (`scripts/final-audit.mjs`).

### Changed

- **External tools are active runtime dependencies, not just Settings entries.**
  A verified managed yt-dlp or FFmpeg install/update now switches the daemon's
  active executable path, invalidates cached capabilities, and makes new media
  probes, extension resolutions, and downloads use it without a daemon restart.
  Startup discovers registered NOVA-managed tools before capability warming; an
  uninstall restores the bundled/fallback path rather than leaving a deleted
  executable active.
- **Repository unification.** Centralized all repository policy at the root
  (`.gitignore`, `.gitattributes`, `.editorconfig`, `.npmrc`, `.prettierrc`,
  `.node-version`, `pnpm-workspace.yaml`) and moved all documentation except the
  root `README.md` under `docs/`. The browser extension is now a source-layout
  submodule with a single canonical lockfile and one CI/Dependabot control plane.
- Reconciled `.env.example` with the variables actually consumed by the app and
  tooling.

### Fixed

- **Browser-download recovery no longer self-cancels.** A browser download that
  NOVA cancels early and then restarts because policy declines takeover receives
  a short-lived, one-shot bypass. The extension therefore lets its own recovery
  download proceed instead of intercepting and cancelling it again.
- **Adaptive engine is now live.** Decisions (split/merge/rebalance, connection
  redistribution) are applied to active easy handles with a debounced rebuild
  loop; `adaptive` (default on) and `adaptiveEvalMs` options added.
- **Pause actually pauses.** `RateLimit::{Unlimited,Limit,Paused}` and a pause
  gate in both drive loops stop bytes from moving while paused.
- **Live rate limits.** Bandwidth changes are pushed to running handles every
  tick instead of at handle creation; removed the implicit 500 B/s / 15 s
  low-speed abort that killed legitimate slow downloads.
- **Scheduler is edge-triggered** — Shutdown/Sleep/Notify fire once per
  condition instead of every 60 s tick; macOS sleep uses `pmset sleepnow`.
- **Honest capability reporting** — `hlsDashDownload` and `supportedRawOptions`
  now reflect reality.
- **Race-free telemetry** — `TelemetryBus` recomputes aggregates from slots;
  prefix-segment rebalance never re-downloads overlapped bytes; symmetric
  retry jitter; `ProfileStore` surfaces write errors; watchdog joins bounded.
- **Frontend** — `novaClient` works without `window`; translations loader is
  explicit; `bridgeStore` keeps degraded mode in sync; Polish locale encoding
  repaired.

### Notes

This is the first tracked changelog entry. Earlier history is captured in the
initial repository import.

## [0.1.0] - Unreleased

Initial development baseline:

- Tauri desktop shell with a React UI and an in-process Rust daemon.
- Direct-download engine using linked static `libcurl` (segmented byte-range
  downloads, generation-guarded pause/resume, atomic merge, runtime protocol and
  feature validation).
- Media engine via `yt-dlp` + FFmpeg with capability-gated post-processing.
- Manifest V3 browser companion with a local-only loopback + Native Messaging
  bridge and protocol v4.
- Branded Windows NSIS installer with full install/upgrade/repair/uninstall
  lifecycle and Native Messaging registration.
- Runtime capability gating across desktop UI, extension, and daemon.

[Unreleased]: https://github.com/Alaa91H/NOVADownloadManager/compare/v2.4.25-alpha...HEAD
[2.4.25-alpha]: https://github.com/Alaa91H/NOVADownloadManager/compare/v2.4.24-alpha...v2.4.25-alpha
[2.4.24-alpha]: https://github.com/Alaa91H/NOVADownloadManager/compare/v2.4.23-alpha...v2.4.24-alpha
[2.4.23-alpha]: https://github.com/Alaa91H/NOVADownloadManager/compare/v2.4.22-alpha...v2.4.23-alpha
[2.4.22-alpha]: https://github.com/Alaa91H/NOVADownloadManager/compare/v2.4.21-alpha...v2.4.22-alpha
[2.4.21-alpha]: https://github.com/Alaa91H/NOVADownloadManager/compare/v2.4.20-alpha...v2.4.21-alpha
[0.1.0]: https://github.com/Alaa91H/NOVADownloadManager/releases/tag/v0.1.0
