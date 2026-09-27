# Architectural Decision Log

This document records key architectural decisions made for the NOVA Download Manager. Each entry explains **what** was decided, **why**, and **what alternatives were considered**.

---

## ADR-001: Use libcurl multi for direct downloads (not reqwest/hyper alone)

**Status:** Accepted  
**Date:** 2024-Q4

### Decision
The direct download engine uses a Rust binding to `libcurl multi` (the `curl` crate) rather than the `reqwest`/`hyper` async HTTP stack alone.

### Rationale
- libcurl has decades of battle-tested protocol support (HTTP/1.1, HTTP/2, FTP, SFTP, segmented byte-ranges).
- Native multi-handle enables concurrent connections within a single OS thread without spawning per-connection tasks.
- Feature availability is detected at runtime via `curl_version_info`, allowing the UI to gate controls on actual capability rather than compile-time assumptions.
- `reqwest` is still used for lightweight auxiliary requests (yt-dlp metadata, Telegram API) where libcurl's complexity is unnecessary.

### Alternatives Considered
- Pure `reqwest` + `hyper`: simpler Rust-native but lacks runtime protocol/feature introspection and FTP/SFTP support.
- `aria2c` as a subprocess: adds a separate process lifecycle and IPC complexity; libcurl in-process is faster and more controllable.

---

## ADR-002: Tauri (not Electron) for the desktop shell

**Status:** Accepted  
**Date:** 2024-Q3

### Decision
The desktop application uses Tauri 2 with a WebView-based frontend rather than Electron.

### Rationale
- Tauri uses the OS-native WebView, resulting in significantly smaller binary sizes (~5–10 MB vs ~100+ MB for Electron).
- Rust backend provides memory safety and direct system API access without Node.js overhead.
- Tauri's IPC (Tauri commands) provides a typed, auditable command surface between the frontend and daemon.

### Alternatives Considered
- Electron: mature ecosystem but large binary, Node.js overhead, and difficult to integrate with Rust-native engines.
- Native Win32/Qt/GTK UI: far higher development cost for 35-language, 6-theme, accessible UI.

---

## ADR-003: Runtime capability gating (not compile-time feature flags)

**Status:** Accepted  
**Date:** 2024-Q4

### Decision
All engine capabilities (protocol support, FFmpeg availability, yt-dlp presence) are queried at runtime from the daemon and surfaced via `EngineCapabilityContext`. The UI never assumes a feature is available without confirming from the daemon.

### Rationale
- Users may install NOVA on machines with different system libraries; compile-time flags would not capture this.
- Consistent model: the browser extension also checks `/api/engines/capabilities` before offering handoff.
- Reduces false affordances: a UI control that appears enabled but fails confuses users more than one that is correctly hidden.

### Alternatives Considered
- Compile-time feature flags: simpler but incorrect for distribution where the runtime environment varies.
- Silent fallback (try and fail): acceptable for optional features but unacceptable for core download workflows.

---

## ADR-004: Manifest V3 browser extension (not V2)

**Status:** Accepted  
**Date:** 2024-Q4

### Decision
The browser companion targets Manifest V3 for Chrome/Edge and the equivalent WebExtensions API for Firefox.

### Rationale
- Google Chrome will remove V2 support; building on V3 ensures long-term store compliance.
- V3's service worker model is compatible with NOVA's lightweight background listener pattern.
- Firefox supports the same APIs via `browser_specific_settings` polyfill.

### Alternatives Considered
- Staying on MV2: would require a complete rewrite when Chrome enforces removal; not viable long-term.

---

## ADR-005: Single pnpm workspace (no per-package lockfiles)

**Status:** Accepted  
**Date:** 2025-Q1

### Decision
All JavaScript packages (desktop frontend, browser extension) share a single `pnpm-workspace.yaml` and one root `pnpm-lock.yaml`.

### Rationale
- Eliminates dependency divergence between packages.
- Simplifies CI: one install step, one lockfile to audit.
- `resolvePeersFromWorkspaceRoot: false` is used to allow Vite version mismatches between the desktop (Vite 6) and extension (Vite 8 via WXT).

### Alternatives Considered
- Separate lockfiles per package: easier to evolve independently but creates audit surface fragmentation and CI complexity.

---

## ADR-006: panic = "abort" in release builds

**Status:** Accepted  
**Date:** 2025-Q2

### Decision
The Rust release profile uses `panic = "abort"` instead of `"unwind"`.

### Rationale
- Eliminates unwind tables from the binary, reducing size.
- Eliminates the risk of catching panics silently (`std::panic::catch_unwind`) in library code.
- A panic hook logs the thread, file, line, and payload before aborting, providing crash diagnostics without requiring debug symbols.

### Alternatives Considered
- `panic = "unwind"` with `catch_unwind`: allows recovery in some code paths, but NOVA's daemon design uses per-route error handling via `Result` — panics indicate logic bugs that should abort, not recover.
