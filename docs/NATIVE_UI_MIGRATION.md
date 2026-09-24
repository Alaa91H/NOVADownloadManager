# NOVA Native UI Migration Plan

Branch: `feature/qt6-native-desktop-ui`

Technology baseline: **Qt 6.8 LTS + C++20 + QML / Qt Quick Controls 2**.

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

Status: **in progress — core desktop integration implemented**.

Implemented:

- Persistent native preferences through `QSettings`.
- System tray with Show/Quit behavior and close-to-tray/start-minimized support.
- Native completion/failure desktop notifications.
- Native file and folder dialogs through `QFileDialog`.
- Windows taskbar download progress through `ITaskbarList3`.
- Linux launcher progress/count integration through Unity LauncherEntry DBus.
- Desktop menu bar and global navigation/workflow shortcuts.
- Native Settings workspace for engine capabilities, profiles, bandwidth and retry policy.
- Full daemon diagnostics and structured runtime log viewer.
- Safe Stable/Preview update checks against published GitHub releases.
- Update installation remains intentionally disabled while the production signed-updater endpoint and public verification key are not configured.

Remaining before Stage 4 is considered complete:

- Signed automatic updater installation after the existing updater signing requirements are satisfied.
- macOS Dock progress integration and platform validation.
- Final desktop menu/shortcut behavior validation across Windows, macOS and Linux.

### Stage 5 — Localization and platform polish

Status: **in progress — localization/theme/accessibility foundation implemented**.

Implemented in the first Stage 5 slice:

- Central native localization manager with live language switching.
- Initial English, Arabic and German dictionaries, including automatic system-language resolution.
- Application-wide RTL mirroring when Arabic is active.
- Persistent language preference through `QSettings`.
- System / Light / Dark appearance modes with live system color-scheme tracking.
- High-contrast mode.
- Reduced-motion preference and shared animation-duration tokens.
- Adjustable text scale and shared typography tokens.
- Dynamic light/dark semantic color palette.
- Localized main menus, navigation rail, command bar, status bar and primary Settings headings.
- Keyboard focus rings and accessibility names for the primary navigation and command actions.

Remaining before Stage 5 is complete:

- Migrate every page/dialog string into the localization catalog.
- Import the full language set supported by the legacy UI.
- Complete per-page RTL layout review, especially tables, inspectors and mixed URL/path content.
- Extend typography scaling to every legacy-sized text declaration.
- Accessibility labels/descriptions and tab order for all dialogs, lists, tables and form controls.
- Screen-reader validation and color-contrast validation.
- High-DPI and multi-monitor validation.
- macOS-specific visual/accessibility refinement and cross-platform platform polish.

### Stage 6 — Parity freeze
No new legacy-UI-only features. Run automated parity tests and release native preview builds.

### Stage 7 — Replacement
Merge the native frontend into the primary release pipeline, remove the old React/Tauri UI, and keep the Rust daemon/core unchanged unless separately justified.
