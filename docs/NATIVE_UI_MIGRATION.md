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
- Full legacy language metadata is now exposed in the native selector, with resource-backed reuse of matching legacy locale entries and English fallback while native-key coverage is expanded.
- Curated semantic aliases now bridge navigation, download actions, queue/scheduler controls, media options, settings, shortcuts and browser status copy to legacy locale keys; CI rejects regressions below 42% reusable native-key coverage; canonical English matching safely reuses legacy translations when only case or punctuation differs.
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
- Every native QML TextField now exposes Accessible.name; advanced network, media, queue, scheduler and batch fields were completed in this hardening pass.
- Technical monospace fields and network/path inputs remain explicitly LTR inside RTL layouts where required.
- CI now rejects fixed numeric font.pixelSize declarations so text scale remains effective across native QML.

Remaining before Stage 5 is complete:

- Continue native-key translation coverage beyond the CI-enforced 40% legacy-reuse floor; unmatched native-only copy still falls back to English until a safe equivalent or dedicated translation is available.
- Complete per-page RTL layout review, especially tables, inspectors and mixed URL/path content.
- Extend typography scaling to every legacy-sized text declaration.
- Complete accessibility labels/descriptions and tab order beyond TextFields, especially complex lists, tables, dialogs and custom controls.
- Screen-reader validation and color-contrast validation.
- High-DPI and multi-monitor validation.
- macOS-specific visual/accessibility refinement beyond the implemented Dock progress integration, plus remaining cross-platform accessibility polish.

### Stage 6.1 — True parity & production hardening

Status: **in progress — structural parity claims corrected; replacement gate is explicitly not ready**.

Stage 6.1 keeps the legacy UI intact while the Qt frontend is verified against real legacy behavior. A capability may be marked `covered` only when the migrated workflow is functionally equivalent enough for replacement, not merely because matching files, API names or source tokens exist.

Implemented:

- Machine-readable parity manifest at `desktop-native/parity/parity-manifest.json`.
- The manifest now declares `releaseReplacementReady`; it is currently `false`.
- The parity validator rejects any manifest that claims replacement readiness while partial/gap/blocked capabilities remain.
- `check-parity.mjs --require-complete` is the production replacement gate.
- Pull requests targeting `main` run the complete replacement gate, so the legacy UI cannot be removed while blockers remain.
- Native preview builds still validate evidence files/tokens and carry a generated `PARITY_REPORT.md`.
- Batch Import, Media Downloader, Queue Management, Scheduler, and Settings & Diagnostics are now `covered` after behavioral parity work and migration tests.
- Batch Import is behaviorally covered: clipboard paste, 10k bounded numeric/alphabetic/stepped/combined expansion, preview counting, exact deduplication, runtime protocol/capability gating, queue selection, destination/connections/start behavior and advanced Referer/User-Agent/proxy/header/cookie/retry/timeout controls.
- Media Downloader is behaviorally covered: debounced probing, playlist auto-detection and item selection, quality/audio/output-template workflows, subtitles/thumbnails/metadata, format selector/sort/sections/filter/remux/SponsorBlock, proxy/source-address/browser cookies/headers/cookies and rate/retry/fragment/sleep controls, all filtered against runtime media capabilities.
- Queue Management is behaviorally covered: daemon-owned persistent catalogs, one-time legacy migration, queue create/update/delete/reorder, authoritative task membership, per-queue task ordering, priority controls, `maxActive` start/stop behavior, queue speed limits and persistence of schedule/retry/completion settings.
- Scheduler is behaviorally covered: daemon-owned Once/Daily/Custom queue windows (including overnight custom-day handling), ordered max-active execution, fixed-delay queue retry policy, temporary one-run bandwidth limits, per-queue engine profiles, edge-triggered completion actions, opt-in Shutdown/Sleep power commands and native `exitOnComplete` handling. Generic automation rules remain available separately.
- Settings & Diagnostics is behaviorally covered: two-stage legacy migration, full curl network/performance/TLS defaults, VPN/interface binding, persistent speed limiting, media defaults, daemon-owned external-tool controls, Telegram migration with post-success token removal, all 14 configurable shortcuts, sanitized JSON backup/restore, engine/log controls, diagnostics and runtime logs.
- Legacy queue definitions are bridged through the daemon `/api/queues` catalog so Qt can select empty custom queues without reading WebView localStorage directly.
- Core Downloads columns support persistent show/hide configuration and persistent ascending/descending sorting through the native model/QSettings path.
- Clipboard URL monitoring matches the legacy 1.5-second detection behavior and ignores pre-existing clipboard content.
- Browser integration exposes daemon-backed status and user-scoped Native Messaging registration repair on Windows, macOS and Linux.
- The native runtime remains split into `nova-native` (Qt UI), `nova-native-backend` (headless Rust daemon) and `nova-native-host` (browser Native Messaging transport).
- Native pairing now uses a random per-daemon proof stored beside the port file. The daemon issues a full local Desktop token only to Qt and a separate route-scoped Browser token only to the Native Messaging host; direct browser HTTP token minting is rejected.
- Windows preview bundles deploy Qt through `windeployqt`; macOS uses `macdeployqt`; Linux preview builds include explicit runtime dependency reporting.
- CI targets Windows x64/ARM64, Linux x64/ARM64 and macOS ARM64/x64 with architecture assertions.
- Native CTest coverage stress-loads 20,000 downloads and validates SSE disconnect/reconnect with bounded backoff.

Current replacement blockers:

- Full legacy language catalog beyond the current English/Arabic/German native baseline.
- Packaged browser-capture E2E validation with the real NOVA extension on Windows, macOS and Linux.
- Production signed automatic updater installation.
- Six-platform CI must complete successfully for the exact candidate commit.
- Final screen-reader, multi-monitor, mixed-DPI and accessibility validation.
- Production-grade Linux packaging and release/upgrade validation.

Stage 6.1 does **not** authorize removing the legacy UI. Stage 7 may begin only after the complete replacement gate passes.

### Stage 7 — Replacement
Merge the native frontend into the primary release pipeline, remove the old React/Tauri UI, and keep the Rust daemon/core unchanged unless separately justified.
