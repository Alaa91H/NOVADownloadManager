# NOVA Native UI Replacement Record

Technology baseline: **Qt 6.8+ + C++20 + QML / Qt Quick Controls 2**.

## Replacement status

**Stage 7 — native UI primary: implemented.**

The former React/Vite/Tauri desktop interface has been removed from the repository. The Qt frontend under `desktop-native/` is now the only desktop presentation layer and the primary mainline UI.

The Rust runtime remains the source of truth for download execution and engine capabilities:

```text
Qt Native UI
    |
    | authenticated REST + event stream
    v
NOVA Rust runtime
    |
    +-- libcurl multi / nova-download-core
    +-- yt-dlp + FFmpeg
    +-- queues / scheduler / rules
    +-- browser Native Messaging bridge
```

## Completed replacement work

- Downloads list, live progress and core task actions.
- Add-download, properties and file/folder operations.
- Queue management and scheduler.
- Batch import.
- Media downloader and advanced media options.
- Link grabber.
- Settings, diagnostics and runtime logs.
- Desktop tray/notifications and platform progress.
- Clipboard monitoring.
- Persistent columns, sorting, search and filtering.
- Keyboard navigation and shortcuts.
- English/Arabic release localization and RTL.
- System/light/dark themes, high contrast, reduced motion and text scaling.
- Approved frameless NOVA visual shell with compact navigation and persistent layout customization.
- High-DPI automated tests and accessibility semantics gates.
- Native Messaging pairing/status/repair path and packaged-host protocol smoke tests.
- Large-list and recovery tests.
- Removal of the legacy `src/` frontend, Vite entry points, Tauri desktop bootstrap/config, SPA serving and Tauri desktop dependencies.
- Promotion of the native desktop CI to `main` and release tags.

## Mainline vs production readiness

Source replacement and production release readiness are separate gates.

Qt/QML is the mainline desktop UI now. A production tag is still blocked until:

- real Chrome/Edge/Firefox packaged extension E2E completes;
- the signed automatic updater endpoint/key and install flow are production-ready;
- the exact release candidate completes the six-platform matrix successfully;
- final NVDA/JAWS/VoiceOver/Orca and physical mixed-DPI/multi-monitor validation completes;
- remaining platform packaging/release-upgrade validation is complete.

These gates are tracked in `desktop-native/parity/parity-manifest.json`.

The strict release command is:

```bash
node desktop-native/scripts/check-parity.mjs --require-complete
```

Release automation runs this command before creating a tag.
