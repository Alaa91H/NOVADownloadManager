# NOVA Native Desktop UI

This directory is the independent next-generation desktop interface for NOVA Download Manager.

## Scope

The native interface is intentionally isolated from the existing React/Tauri frontend. The legacy UI remains the production reference until the native implementation reaches feature parity and passes the migration gates documented in `docs/NATIVE_UI_MIGRATION.md`.

The new UI uses:

- Qt 6.8 LTS or newer
- C++20
- Qt Quick / QML
- Qt Quick Controls 2
- Qt Network
- CMake 3.24+
- The existing NOVA Rust daemon and download engines

It does **not** reimplement libcurl multi, yt-dlp/FFmpeg routing, queue execution, scheduler execution, browser capture, or the Rust core.

## Build

Requirements:

- CMake 3.24+
- Qt 6.8+ with Quick, QuickControls2 and Network
- A C++20 compiler

Example:

```bash
cmake -S desktop-native -B build/native -DCMAKE_PREFIX_PATH=/path/to/Qt/6.8/lib/cmake
cmake --build build/native --config Release
```

## Development connection

The first milestone connects to the existing daemon HTTP API.

Optional environment variables:

```text
NOVA_API_BASE=http://127.0.0.1:3199
NOVA_API_TOKEN=<daemon bearer token>
```

Production native builds use an automatic bootstrap: the Qt UI first discovers an existing loopback daemon and, if necessary, starts the bundled `nova-native-backend`. It then obtains the bearer token through the trusted local desktop auto-pair contract. `NOVA_API_BASE` / `NOVA_API_TOKEN` remain development overrides only.

## Current milestone

The branch is now in **Stage 6.1 — True Parity & Production Hardening**.

Implemented native surfaces include:

- Live downloads and event-stream updates
- Add/edit/pause/resume/retry/delete/redownload workflows
- File/folder actions and native file dialogs
- Behaviorally covered Queue Manager, Scheduler and Batch Import
- Behaviorally covered Media Downloader and Link Grabber
- Behaviorally covered settings control center, engine management, diagnostics and runtime logs
- System tray, notifications and Windows/Linux desktop progress
- Stable/Preview release checks with automatic install intentionally disabled until updater signing is production-ready
- Full legacy language selection with resource-backed locale reuse, curated native-to-legacy aliases, a CI-enforced 42% reuse floor, and English fallback for unmatched native-only copy; native English/Arabic/German catalogs remain the highest-coverage baseline, with RTL, System/Light/Dark themes, High Contrast, Reduced Motion and text scaling
- Keyboard shortcuts, focus/accessibility metadata and High-DPI policy
- Windows, Linux and macOS Qt 6.8.3 CI validation
- Bundled headless Rust backend and dedicated browser Native Messaging host
- Rotating-proof trusted-local backend discovery/pairing, scoped browser credentials and cross-platform browser-host registration repair

## Stage 6.1 parity and preview builds

`desktop-native/parity/parity-manifest.json` is the machine-readable parity source of truth.

Run the local gates with:

```bash
node desktop-native/scripts/check-localization.mjs
node desktop-native/scripts/check-native-i18n-coverage.mjs
node desktop-native/scripts/check-native-accessibility.mjs
node desktop-native/scripts/check-product-copy.mjs
node desktop-native/scripts/check-parity.mjs
cmake -S desktop-native -B build/native-tests -DNOVA_BUILD_TESTS=ON
cmake --build build/native-tests --parallel
ctest --test-dir build/native-tests --output-on-failure
```

`check-native-i18n-coverage.mjs` rejects alias drift and any regression below the current 42% native-to-legacy translation reuse floor. `check-native-accessibility.mjs` requires every TextField to expose an accessible name, keeps monospace technical inputs explicitly LTR, and rejects fixed numeric font sizes that bypass text scaling.

The parity command writes `build/native-parity-report.md`. The production replacement gate is `node desktop-native/scripts/check-parity.mjs --require-complete`; it must remain failing until every capability is covered and `releaseReplacementReady` is explicitly enabled.

On the feature branch, GitHub Actions builds native preview artifacts for Windows, Linux and macOS. Each bundle contains:

- the installed native executable/application files;
- `BUILD_INFO.txt` with commit/platform metadata;
- `PARITY_REPORT.md` showing covered, partial, gap and blocked migration gates;
- Windows: Qt runtime deployment via `windeployqt`;
- Linux: runtime dependency report for QA environments.

Known blockers remain explicit in the parity manifest and must be resolved before Stage 7 replacement.
