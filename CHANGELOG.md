# Changelog

All notable changes to NOVA Download Manager are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.24-alpha] - 2026-08-25

### Fixed

- **Windows MSI packaging now accepts alpha and beta release tags.** Tauri bundle
  metadata converts a semantic prerelease label to its equivalent numeric
  prerelease identifier, as required by WiX/MSI, while the application and
  browser-extension packages retain the full user-facing semantic version.
- **Linux CI dependency installation now retries safely after mirror rotation.**
  A bounded helper refreshes stale APT indexes and retries package downloads,
  preventing transient Ubuntu archive 404 responses from failing ARM64 builds.

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

[Unreleased]: https://github.com/Alaa91H/NOVADownloadManager/compare/v2.4.24-alpha...HEAD
[2.4.24-alpha]: https://github.com/Alaa91H/NOVADownloadManager/compare/v2.4.23-alpha...v2.4.24-alpha
[2.4.23-alpha]: https://github.com/Alaa91H/NOVADownloadManager/compare/v2.4.22-alpha...v2.4.23-alpha
[2.4.22-alpha]: https://github.com/Alaa91H/NOVADownloadManager/compare/v2.4.21-alpha...v2.4.22-alpha
[2.4.21-alpha]: https://github.com/Alaa91H/NOVADownloadManager/compare/v2.4.20-alpha...v2.4.21-alpha
[0.1.0]: https://github.com/Alaa91H/NOVADownloadManager/releases/tag/v0.1.0
