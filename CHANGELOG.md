# Changelog

All notable changes to NOVA Download Manager are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
