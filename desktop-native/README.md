# NOVA Native Desktop UI

This directory is the independent next-generation desktop interface for NOVA Download Manager.

## Scope

The native interface is intentionally isolated from the existing React/Tauri frontend. The legacy UI remains the production reference until the native implementation reaches feature parity and passes the migration gates documented in `docs/NATIVE_UI_MIGRATION.md`.

The new UI uses:

- Qt 6.5+
- C++20
- Qt Quick / QML
- Qt Network
- The existing NOVA Rust daemon and download engines

It does **not** reimplement libcurl multi, yt-dlp/FFmpeg routing, queue execution, scheduler execution, browser capture, or the Rust core.

## Build

Requirements:

- CMake 3.24+
- Qt 6.5+ with Quick, QuickControls2 and Network
- A C++20 compiler

Example:

```bash
cmake -S desktop-native -B build/native -DCMAKE_PREFIX_PATH=/path/to/Qt/6.x/lib/cmake
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

Implemented:

- Native application/window bootstrap
- Native navigation rail
- Desktop command bar
- Live engine health state
- Download model backed by `/api/downloads`
- Native list/progress/status presentation
- Bottom status bar
- Independent CMake build

Next:

1. Trusted local authentication/bootstrap
2. SSE download delta stream
3. Selection model and real task commands
4. Add Download workflow
5. Details/Inspector pane
6. Native context menus and shortcuts
7. Queue/Scheduler workspace
8. Media and Link Grabber workspaces
9. Settings
10. Full i18n/RTL migration
