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
- macOS Dock integration renders aggregate download progress over the application icon and exposes the active-download count through the native Dock badge.
- Desktop menu bar and global navigation/workflow shortcuts.
- Native Settings workspace for engine capabilities, profiles, bandwidth and retry policy.
- Full daemon diagnostics and structured runtime log viewer.
- Safe Stable/Preview update checks against published GitHub releases.
- Update installation remains intentionally disabled while the production signed-updater endpoint and public verification key are not configured.

Remaining before Stage 4 is considered complete:

- Signed automatic updater installation after the existing updater signing requirements are satisfied.
- Final desktop menu/shortcut behavior validation across Windows, macOS and Linux.

### Stage 5 — Localization and platform polish

Status: **in progress — functional localization/theme/accessibility layer implemented; platform validation remains**.

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
- Localized Downloads workspace, queue manager, batch import, scheduler, media downloader, link grabber, Settings/Diagnostics and core download dialogs.
- RTL-safe URL/path/output-template fields that explicitly remain left-to-right inside Arabic layouts.
- Shared text-scale tokens applied across the localized workflows.
- Explicit keyboard tab order for primary create/edit dialogs and scheduler rule entry.
- Expanded accessibility names/descriptions for navigation, download rows, scheduler rules, logs and primary form controls.
- Explicit Qt High-DPI scale-factor rounding policy.
- CI localization gate that rejects newly introduced hard-coded user-visible English QML copy while allowing narrowly scoped technical literals.
- Keyboard focus rings and accessibility names for the primary navigation and command actions.

Remaining before Stage 5 is complete:

- Import the full language set supported by the legacy UI beyond the current English, Arabic and German baseline.
- Complete per-page RTL layout review, especially tables, inspectors and mixed URL/path content.
- Extend typography scaling to every legacy-sized text declaration.
- Accessibility labels/descriptions and tab order for all dialogs, lists, tables and form controls.
- Screen-reader validation and color-contrast validation.
- High-DPI and multi-monitor validation.
- macOS-specific visual/accessibility refinement beyond the implemented Dock progress integration, plus remaining cross-platform accessibility polish.

### Stage 6 — Parity freeze

Status: **in progress — executable parity gate and native preview pipeline added**.

Stage 6 freezes the feature surface: existing legacy-only capabilities must be tracked as explicit parity gaps, and newly covered native capabilities must carry verifiable implementation evidence.

Implemented:

- Machine-readable parity manifest at `desktop-native/parity/parity-manifest.json`.
- Automated parity validation that checks every merge/removal gate has a tracked status.
- Covered capabilities must reference real evidence files and required implementation/API tokens.
- Partial, gap and externally blocked capabilities must carry an explicit blocker instead of being silently treated as complete.
- CI now runs both localization and Stage 6 parity gates before installing Qt/building the native application.
- Native UI workflow also runs when legacy `src/**`, daemon `src-tauri/**` or migration-plan changes can affect parity.
- Every successful Windows/Linux/macOS CI build installs a versioned native preview bundle.
- Core Downloads columns now support persistent show/hide configuration and persistent ascending/descending sorting through the native model/QSettings path.
- Clipboard URL monitoring now matches the legacy 1.5-second detection behavior: it ignores pre-existing clipboard content, extracts new HTTP/HTTPS links and opens the native Add Download dialog only after the engine is connected.
- Browser integration now exposes live daemon-backed status, enabled/paired state, bridge version, capture endpoint and direct/media/post-processing capabilities in the native Settings workspace.
- Native Qt can now enable or disable browser capture through the daemon's existing `/api/browser-extension/config` endpoint. The daemon applies only the browser-enable patch atomically and preserves unrelated settings and protected pairing credential markers.
- Native browser diagnostics validate Chrome/Chromium, Edge and Firefox Native Messaging registration plus the manifest/host executable.
- Native Messaging registration repair is now user-scoped on Windows, macOS and Linux. The Qt application generates atomic manifests that point only to the bundled sibling `nova-native-host` executable.
- The production native runtime is split into `nova-native` (Qt UI), `nova-native-backend` (headless Rust daemon) and `nova-native-host` (browser Native Messaging transport). Qt discovers an existing daemon first, otherwise starts the bundled backend and obtains its bearer token through the trusted loopback desktop auto-pair contract.
- Native browser integration follows the project's zero-click pairing security model: pairing credentials are never displayed or copied by the Qt UI; setup links route users to the extension release and pairing documentation.
- Windows preview bundles deploy the required Qt runtime through `windeployqt`.
- Linux preview bundles include the Qt UI, Rust backend/native host, desktop entry, an `ldd` runtime dependency report and a live backend auto-pair smoke test.
- macOS 15 ARM64 (Apple Silicon) preview builds are part of the native CI matrix and package the Rust backend/native host beside the Qt application executable. The runner is pinned to macOS 15 because Qt 6.8 LTS is the project baseline.
- Platform-validation CI now also targets Windows 11 ARM64, Ubuntu 24.04 ARM64 and macOS 15 Intel, with architecture assertions for the Qt UI, Rust backend and Native Messaging host so emulated/wrong-architecture binaries cannot count as parity evidence.
- Every preview bundle carries `PARITY_REPORT.md` and `BUILD_INFO.txt` for QA traceability.
- Native CTest coverage now stress-loads 20,000 downloads, validates filter/sort/search responsiveness, forces a real SSE disconnect/reconnect, and verifies bounded reconnect backoff.
- Download table parity now includes elapsed time, date added, retries, connection count, CRC32 placeholder parity, queue-derived priority, completed date, source URL and smart category, with persistent visibility/sort settings and synchronized horizontal scrolling for wide column sets.
- The Qt bootstrap now recovers from an owned Rust backend process exit by rediscovering/restarting the backend and re-pairing without restarting the UI.
- Preview artifacts are retained by GitHub Actions for 14 days.

Current parity blockers tracked by the executable manifest:

- Validate packaged browser capture end to end with the real NOVA extension on Windows, macOS and Linux.
- Full legacy language catalog beyond the current English/Arabic/German native baseline.
- Production signed automatic updater installation.
- Windows ARM64, Linux ARM64 and macOS Intel validation beyond the current Windows/Linux x64 + macOS ARM64 matrix.
- Final screen-reader, multi-monitor and platform accessibility validation.

Stage 6 does **not** authorize removing the legacy UI while any merge/removal blocker remains.

### Stage 7 — Replacement
Merge the native frontend into the primary release pipeline, remove the old React/Tauri UI, and keep the Rust daemon/core unchanged unless separately justified.
