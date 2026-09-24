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

The production native bootstrap will replace manual token injection with the same trusted-local pairing/security guarantees used by the current desktop application.

## Current milestone

The branch is now in **Stage 6 — Parity Freeze**.

Implemented native surfaces include:

- Live downloads and event-stream updates
- Add/edit/pause/resume/retry/delete/redownload workflows
- File/folder actions and native file dialogs
- Queue manager, scheduler and batch import
- Media downloader and Link Grabber
- Engine settings, diagnostics and runtime logs
- System tray, notifications and Windows/Linux desktop progress
- Stable/Preview release checks with automatic install intentionally disabled until updater signing is production-ready
- English/Arabic/German live localization, RTL, System/Light/Dark themes, High Contrast, Reduced Motion and text scaling
- Keyboard shortcuts, focus/accessibility metadata and High-DPI policy
- Windows and Linux Qt 6.8.3 CI validation

## Stage 6 parity and preview builds

`desktop-native/parity/parity-manifest.json` is the machine-readable parity source of truth.

Run the local gates with:

```bash
node desktop-native/scripts/check-localization.mjs
node desktop-native/scripts/check-parity.mjs
```

The parity command writes `build/native-parity-report.md`.

On the feature branch, GitHub Actions builds native preview artifacts for Windows and Linux. Each bundle contains:

- the installed native executable/application files;
- `BUILD_INFO.txt` with commit/platform metadata;
- `PARITY_REPORT.md` showing covered, partial, gap and blocked migration gates;
- Windows: Qt runtime deployment via `windeployqt`;
- Linux: runtime dependency report for QA environments.

Known blockers remain explicit in the parity manifest and must be resolved before Stage 7 replacement.
