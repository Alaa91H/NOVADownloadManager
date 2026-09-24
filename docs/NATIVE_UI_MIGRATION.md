# NOVA Native UI Migration Plan

Branch: `الواجهة-الجديدة`

The native desktop UI is developed independently and must not replace the existing frontend until it satisfies the gates below.

## Architecture boundary

The Rust daemon remains the source of truth for downloads and engine capabilities.

```text
Native Qt UI
   |
   | REST + event stream
   v
NOVA Rust daemon
   |
   +-- nova-download-core / libcurl multi
   +-- yt-dlp + FFmpeg
   +-- queues / scheduler
   +-- browser bridge
```

No download-engine behavior may be duplicated in QML or C++ UI code.

## Rules during migration

1. Do not delete or rewrite the current `src/` frontend while native parity is incomplete.
2. New native work lives under `desktop-native/`.
3. Engine/API changes must remain backward-compatible with the current UI during migration.
4. Every migrated feature must be tested against the same daemon behavior as the legacy feature.
5. The native UI owns presentation, native OS integration, commands and view models; Rust owns download execution.
6. New UI-specific state must not become a second source of truth for download state.

## Merge/removal gates

The old interface can be removed only after all of these are true:

- Downloads list and live progress parity
- Add single download parity
- Batch import parity
- Pause/resume/retry/delete/redownload parity
- File/open-folder actions
- Queue management and scheduler parity
- Media downloader parity
- Web/Link Grabber parity
- Browser integration status and pairing parity
- Settings parity
- Diagnostics parity
- Updater parity
- Notifications and tray parity
- Clipboard monitoring parity
- Native file/folder dialogs
- Column configuration, sorting, filtering and search
- Keyboard shortcuts
- RTL correctness
- Translation migration for all supported languages
- Dark/light/system appearance
- Windows x64/ARM64 validation
- macOS Intel/Apple Silicon validation
- Linux x64/ARM64 validation
- Accessibility/keyboard navigation validation
- High-DPI testing
- Large-list performance testing
- Crash/error recovery testing

## Delivery stages

### Stage 1 — Shell and live downloads
Native window, navigation, command surface, download model, engine status and live updates.

### Stage 2 — Core download operations
Add, pause, resume, retry, delete, properties, open file/folder and task inspector.

### Stage 3 — Power workflows
Queues, scheduler, batch import, link grabber and media download.

### Stage 4 — Desktop integration
Tray, notifications, taskbar/dock progress, file dialogs, menus, shortcuts and updater.

### Stage 5 — Localization and platform polish
Full translation import, RTL, themes, accessibility and platform-specific refinement.

### Stage 6 — Parity freeze
No new legacy-UI-only features. Run automated parity tests and release native preview builds.

### Stage 7 — Replacement
Merge the native frontend into the primary release pipeline, remove the old React/Tauri UI, and keep the Rust daemon/core unchanged unless separately justified.
