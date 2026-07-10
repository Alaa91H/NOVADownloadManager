<p align="center">
  <img src="src/assets/logo.png" alt="NOVA Download Manager" width="350" height="350" />
</p>

<h1 align="center">NOVA Download Manager</h1>

<p align="center">
  A professional desktop download manager built around a verified <strong>libcurl multi</strong> core, a matching Manifest V3 browser companion, and a branded Windows installer.
</p>

<p align="center">
  <!-- Project Status, Release & Downloads -->
  <a href="https://github.com/Alaa91H/NOVADownloadManager/releases/latest"><img alt="Latest Release" src="https://img.shields.io/github/v/release/Alaa91H/NOVADownloadManager?logo=github&label=Latest%20Release&color=238636" /></a>&nbsp;
  <a href="https://github.com/Alaa91H/NOVADownloadManager/releases"><img alt="Total Downloads" src="https://img.shields.io/github/downloads/Alaa91H/NOVADownloadManager/total?logo=github&label=Downloads&color=0ea5e9" /></a>&nbsp;
  <a href="https://github.com/Alaa91H/NOVADownloadManager/commits/main"><img alt="Last Commit" src="https://img.shields.io/github/last-commit/Alaa91H/NOVADownloadManager?logo=git&label=Last%20Commit&color=1f6feb" /></a>
</p>
<p align="center">
  <!-- Tech Stack & Features -->
  <img alt="Desktop" src="https://img.shields.io/badge/Desktop-Tauri%20%2B%20Rust-1f6feb?logo=tauri&logoColor=white" />
  <img alt="Engine" src="https://img.shields.io/badge/Direct%20Engine-libcurl%20multi-238636?logo=curl&logoColor=white" />
  <img alt="Media" src="https://img.shields.io/badge/Media-yt--dlp%20%2B%20FFmpeg-8957e5?logo=ffmpeg&logoColor=white" />
  <img alt="Extension" src="https://img.shields.io/badge/Extension-Manifest%20V3-f97316?logo=googlechrome&logoColor=white" />
  <img alt="Installer" src="https://img.shields.io/badge/Installer-NSIS%20Lifecycle-0ea5e9?logo=windows&logoColor=white" />
</p>
<p align="center">
  <!-- Community & Support -->
  <a href="https://t.me/NOVADownloadManager"><img alt="Telegram" src="https://img.shields.io/badge/Telegram-Channel-2CA5E0?logo=telegram&logoColor=white" /></a>&nbsp;
  <a href="https://ko-fi.com/alaa91h"><img alt="Ko-fi" src="https://img.shields.io/badge/Support%20NOVA%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white" /></a>
</p>

---

## Table of contents

- [Overview](#overview)
- [Why NOVA is different](#why-nova-is-different)
- [Core capabilities](#core-capabilities)
- [Architecture](#architecture)
- [Repository structure](#repository-structure)
- [Requirements](#requirements)
- [Development](#development)
- [Build and release](#build-and-release)
- [Performance and optimization](#performance-and-optimization)
- [Quality gates](#quality-gates)
- [Browser extension](#browser-extension)
- [Installer lifecycle](#installer-lifecycle)
- [Internationalization](#internationalization)
- [Documentation](#documentation)
- [Support and community](#support-and-community)

## Overview

NOVA Download Manager is an integrated desktop download manager for direct files, browser-captured links, and media workflows. It combines a Tauri desktop shell, a Rust daemon, an in-process `libcurl multi` direct-download engine, `yt-dlp + FFmpeg` media processing, and a browser companion that uses a strict local bridge to hand off download candidates.

The project is designed as a single product rather than separate disconnected tools. The desktop UI, daemon, browser extension, Native Messaging host, NSIS installer, scripts, audits, and documentation share one repository policy and one release pipeline.

## Why NOVA is different

NOVA does not expose fake capabilities. The application asks the daemon which engine features are available at runtime and then gates the UI, extension, and API accordingly. If a linked `libcurl` build does not support a protocol or feature, NOVA does not show it as available. If FFmpeg is not present, media post-processing controls are disabled. If a stream manifest is detected, NOVA routes it through `yt-dlp + FFmpeg` instead of downloading it as a text file.

This runtime-verified model keeps the product predictable, debuggable, and safe across release builds.

## Core capabilities

### Direct download engine

- In-process Rust download engine using linked `libcurl multi`.
- Segmented byte-range downloads when the server and runtime engine support ranges.
- Pause/resume guarded by generation tokens to prevent stale workers from writing into resumed tasks.
- Safe single-connection resume for servers that do not support reliable segmentation.
- Atomic segment merge with final-size verification.
- Runtime validation of linked `libcurl` version, protocols, and features against the build manifest.
- Protocol gating for direct downloads before UI submission and before browser-extension handoff.

### Media engine

- Media downloads routed through `yt-dlp`.
- FFmpeg integration for merge, remux, metadata, thumbnails, subtitles, chapters, audio extraction, and post-processing workflows.
- HLS/DASH candidates routed to the media engine instead of direct file download.
- UI gating for media options through runtime-supported media capabilities.

### Browser companion

- Manifest V3 extension compatible with Chrome, Edge, and Firefox.
- Direct link capture, context-menu capture, deep DOM scan, media-element probing, OpenGraph/JSON-LD discovery, HLS/DASH detection, and smart candidate filtering.
- Aggressive capture support for `fetch`, XHR, `MediaSource`, WebSocket, EventSource, and object URL patterns.
- 28 platform adapters (YouTube, Bilibili, Twitch, TikTok, Dailymotion, Vimeo, Reddit, Instagram, Facebook, Twitter, SoundCloud, LinkedIn, Telegram, and more).
- Visual popup and overlay aligned with the desktop NOVA design system.
- Local-only bridge using loopback HTTP and Native Messaging host `com.nova.downloadmanager`.

### Installer and desktop integration

- Branded NSIS installer header and sidebar generated from the NOVA visual identity.
- Install, upgrade, maintenance/repair-style reinstall, uninstall, legacy cleanup, and Native Messaging registration hooks.
- Native Messaging manifest generation for Chromium-family browsers and Firefox.
- Safe process handling: NOVA targets only processes launched from the installed application directory.
- Dark theme with HiDPI scaling, NOVA accent colors, and professional typography.

### Desktop UI

- Dark-first design system with 6 themes (Dark, Midnight, Graphite, Nord, Solar, Light) and 5 accent colors (Blue, Emerald, Amber, Crimson, Violet).
- 3 density modes (Compact, Dense, Normal) with reduced-motion support.
- Glassmorphism panels, custom scrollbars, and CSS containment for optimal rendering performance.
- 35 supported interface languages with lazy-loaded translation chunks.
- Download queues, scheduling, batch import, and smart categories.
- Active progress dialog, task properties, diagnostics panel, and comprehensive settings.

## Architecture

```text
Browser Extension / Desktop UI
          │
          ▼
Capability gating and protocol validation
          │
          ▼
Tauri command layer + local daemon API
          │
          ▼
Routing layer
  ├─ Direct files      → in-process libcurl multi (Rust static link)
  ├─ HLS/DASH/media   → yt-dlp + FFmpeg (subprocess)
  ├─ Browser bridge   → loopback HTTP (127.0.0.1) + Native Messaging
  └─ Installer hooks  → NSIS lifecycle (registry, native-host setup)
```

The central principle is that all user-facing controls are derived from engine capabilities. The root desktop app uses `EngineCapabilityContext`; the browser extension consumes daemon capabilities before sending candidates; the daemon performs final validation before starting a task.

## Repository structure

```text
.
├─ .github/                         CI workflows and Dependabot configuration
├─ branding/source/                 Master artwork (app icon, installer banners)
├─ browser-extension/               Manifest V3 extension source, tests, and packaging
├─ docs/                            All documentation except this root README
│  ├─ architecture/                 Engine, capability, and source-tree architecture
│  ├─ extension/                    Browser extension docs, CI templates, protocol specs
│  ├─ maintenance/                  Dependabot and product-maintenance notes
│  └─ release/                      Release, store, testing, and publishing docs
├─ public/                          Desktop public assets (favicons)
├─ scripts/                         Build, audit, native curl, cleanup, and release helpers
├─ src/                             Desktop React interface (35 languages, 6 themes)
├─ src-tauri/                       Rust daemon, libcurl engine, NSIS config, icons
├─ .editorconfig                    Repository-wide editor rules
├─ .gitattributes                   Line-ending and binary file policy
├─ .gitignore                       Generated-file and artifact policy
├─ CHANGELOG.md                     Release changelog
├─ CODE_OF_CONDUCT.md               Contributor Covenant code of conduct
├─ CONTRIBUTING.md                  Contributor guide
├─ LICENSE                          MIT License
├─ README.md                        This file
├─ SECURITY.md                      Security reporting policy
├─ THIRD_PARTY_NOTICES.md           Bundled engine license notices
├─ eslint.config.mjs                ESLint flat config
├─ index.html                       Vite entry HTML
├─ package.json                     Root product scripts and orchestration
├─ pnpm-lock.yaml                   Canonical lockfile (single root)
├─ pnpm-workspace.yaml              Workspace policy (root + browser-extension)
├─ tsconfig.json                    TypeScript configuration
├─ vite.config.ts                   Vite build configuration
└─ vitest.config.ts                 Vitest test configuration
```

The browser extension is a product submodule in source layout only. It no longer carries its own nested GitHub workflow, Dependabot, docs, devcontainer, duplicate repository policy files, or extension-local lockfile. Those are centralized at the repository root or under `docs/`.

## Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 24.x | Frontend build, scripts, extension |
| pnpm | 11.x | Package manager (workspace) |
| Rust | stable | Daemon, libcurl engine, Tauri |
| CMake | 3.x | Native libcurl builds |
| FFmpeg | 7.x | Media post-processing (bundled at build time) |
| Windows | 10+ | NSIS installer builds |

Node.js and pnpm versions are pinned by `.node-version` and `packageManager` in `package.json`. The Rust edition is 2021 with minimum version 1.77.

## Development

Install dependencies:

```bash
pnpm install
```

Build the native curl runtime and fetch helper engines:

```bash
pnpm run native-curl:build
pnpm run fetch-engines
```

Run the desktop app in development:

```bash
pnpm run tauri:dev
```

Run only the frontend against an existing daemon:

```bash
pnpm run dev
```

Run the browser extension in development:

```bash
pnpm --filter nova-browser-extension dev
```

## Build and release

Build the desktop frontend:

```bash
pnpm run build
```

Build extension packages:

```bash
pnpm run extension:package
```

Build the full Tauri/NSIS installer (builds native curl, fetches engines, packages extension, then builds the installer):

```bash
pnpm run tauri:build
```

The CI pipeline (`build.yml`) runs on `windows-latest` with pnpm 11.6.0, Node 24, and Rust stable 1.97.0. It produces:

- SHA-256 checksums for all release artifacts
- `build-metadata.json` with version, commit, and timestamp
- Professional build summary with artifact sizes

## Performance and optimization

NOVA is built for maximum performance, stability, and minimal binary size:

### Rust release profile

```toml
[profile.release]
lto = "fat"              # Whole-program link-time optimization
codegen-units = 1        # Single codegen unit for maximum optimization
strip = "symbols"        # Strip debug symbols from binary
opt-level = 3            # Maximum optimization level
panic = "abort"          # No unwinding overhead
overflow-checks = false  # No bounds-check overhead in release
debug = false            # No debug info in release
incremental = false      # Full rebuild for release

[profile.release.package."*"]
opt-level = 3            # Optimize all dependencies
```

### Frontend optimizations

- CSS `will-change: transform` on animated interactive elements for GPU compositing.
- CSS `contain: layout style` on table rows, glass panels, and segment blocks for layout isolation.
- `text-rendering: optimizeLegibility` and `font-feature-settings` with tabular numerals (`tnum`) for download statistics.
- Lazy-loaded i18n translation chunks (35 languages, loaded on demand).
- Manual chunk splitting: `vendor` (React), `ui` (Lucide icons).

### HTTP client tuning

- Connection pool idle timeout: 90 seconds.
- Maximum idle connections per host: 4.
- Connect timeout: 15 seconds.

### Crash reporting

Release builds include a panic hook that logs thread name, file, line, and payload before aborting, providing crash diagnostics without debug symbols.

## Quality gates

Root product checks:

```bash
pnpm run lint              # TypeScript type check
pnpm run lint:eslint       # ESLint linting
pnpm test                  # Vitest unit tests
pnpm run verify:capabilities   # Engine capability gating verification
pnpm run audit:installer   # NSIS lifecycle audit
pnpm run audit:final       # Comprehensive source audit
```

Browser extension checks:

```bash
pnpm --filter nova-browser-extension typecheck
pnpm --filter nova-browser-extension verify:nova-sync
pnpm --filter nova-browser-extension audit:release
pnpm --filter nova-browser-extension build:zip
```

Rust checks:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

The source audit enforces:

- `lto = "fat"` in the release profile
- `overflow-checks = false` for release builds
- `[profile.release.package."*"]` for dependency optimization
- Panic hook in `main.rs` for crash diagnostics
- No committed `node_modules`, `dist/`, `target/`, or generated bundles
- All governance files present (LICENSE, SECURITY.md, CONTRIBUTING.md, CHANGELOG.md, CODE_OF_CONDUCT.md, THIRD_PARTY_NOTICES.md)
- Correct pnpm workspace configuration and lockfile policy
- Engine capability gating in both desktop UI and browser extension

## Browser extension

The extension is developed under `browser-extension/`, but its documentation and CI templates live in `docs/extension/`. It follows the NOVA desktop visual system and uses runtime capabilities from the daemon before enabling handoff actions.

Important extension commands:

```bash
pnpm --filter nova-browser-extension typecheck
pnpm --filter nova-browser-extension verify:offline
pnpm run extension:package
```

See [docs/extension/README.md](docs/extension/README.md) for the extension architecture, capture model, permissions, privacy model, and store-readiness documentation.

## Installer lifecycle

The Windows installer uses a dark Tauri NSIS Modern UI theme with NOVA-branded HiDPI artwork:

- `src-tauri/windows/installer-header.bmp` — branded installer header
- `src-tauri/windows/installer-sidebar.bmp` — branded sidebar
- `src-tauri/windows/hooks.nsi` — lifecycle hooks (install, upgrade, repair, uninstall)
- `src-tauri/windows/installer-template.nsi` — NSIS template with branded finish page

The single source for product icons, logos, and installer banners is `branding/source/`. Regenerate all target-specific artwork with `pnpm run branding:generate`; the copied files under Tauri, Vite, and WXT folders are generated build inputs, not separate branding sources.

The installer lifecycle covers:

- **Install** — fresh installation with Start Menu shortcuts and registry entries
- **Upgrade** — semver comparison detects existing installations, preserves user data
- **Repair** — maintenance-style reinstall that keeps settings intact
- **Uninstall** — clean removal with optional data preservation
- **Legacy cleanup** — removes artifacts from previous engine configurations
- **Native Messaging** — registers/unregisters browser extension host manifests

CI fallback builds use SemVer build metadata (`v0.1.0+<run>`) instead of prerelease suffixes so rerunning a newer CI installer is treated as an in-place update, while real lower-version downgrades stay blocked.

## Internationalization

NOVA supports **35 interface languages** with lazy-loaded translation chunks:

English, Arabic, Bengali, Bulgarian, Chinese (Simplified), Chinese (Traditional), Czech, Danish, Dutch, Finnish, French, German, Greek, Hebrew, Hindi, Hungarian, Indonesian, Italian, Japanese, Korean, Malay, Norwegian, Persian, Polish, Portuguese, Romanian, Russian, Slovak, Spanish, Swedish, Thai, Turkish, Ukrainian, Urdu, Vietnamese.

English is bundled in the main application bundle as the synchronous fallback. All other languages are loaded on demand as separate chunks to keep startup fast.

The browser extension ships with 25 languages in its bundle (a subset optimized for extension context).

## Documentation

All documentation except this root README is centralized under [`docs/`](docs/README.md):

- [Project structure](docs/architecture/PROJECT_STRUCTURE.md)
- [Capability gating](docs/architecture/CAPABILITY_GATING.md)
- [Engine compatibility](docs/architecture/ENGINE_COMPATIBILITY.md)
- [Browser extension](docs/extension/README.md)
- [Extension architecture](docs/extension/ARCHITECTURE.md)
- [Extension protocol](docs/extension/PROTOCOL.md)
- [Overlay system](docs/extension/OVERLAY.md)
- [DRM guard](docs/extension/DRM_GUARD.md)
- [Permissions model](docs/extension/PERMISSIONS.md)
- [Privacy model](docs/extension/PRIVACY.md)
- [Aggressive capture](docs/extension/AGGRESSIVE_CAPTURE_MODE.md)
- [Zero-click pairing](docs/extension/ZERO_CLICK_PAIRING.md)
- [Dependabot and maintenance](docs/maintenance/DEPENDABOT_AND_MAINTENANCE.md)
- [Release process](docs/release/RELEASE.md) *(coming soon)*
- [Testing](docs/release/TESTING.md) *(coming soon)*
- [Store compliance](docs/release/STORE_COMPLIANCE.md) *(coming soon)*

## Support and community

NOVA is an independent project. Support helps fund maintenance, browser-store packaging, testing, and engine integration work.

<p align="center">
  <a href="https://t.me/NOVADownloadManager"><img alt="Telegram" src="https://img.shields.io/badge/Telegram-Channel-2CA5E0?logo=telegram&logoColor=white" /></a>&nbsp;
  <a href="https://ko-fi.com/alaa91h"><img alt="Ko-fi" src="https://img.shields.io/badge/Support%20NOVA%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white" /></a>
</p>

## License and third-party notices

NOVA Download Manager is released under the MIT License — see [LICENSE](LICENSE).

Bundled engine integrations such as curl/libcurl, yt-dlp, and FFmpeg have independent license requirements that must be preserved in final release artifacts. These are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which the build stages into the installed application directory. Note in particular that FFmpeg builds may be LGPL or GPL depending on their enabled components; record the bundled FFmpeg's license and source in each release.

Project governance:

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
