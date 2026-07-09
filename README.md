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
- [Quality gates](#quality-gates)
- [Browser extension](#browser-extension)
- [Windows installer](#windows-installer)
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

- Manifest V3 extension.
- Direct link capture, context-menu capture, deep DOM scan, media-element probing, OpenGraph/JSON-LD discovery, HLS/DASH detection, and smart candidate filtering.
- Aggressive capture support for `fetch`, XHR, `MediaSource`, WebSocket, EventSource, and object URL patterns.
- Visual popup and overlay aligned with the desktop NOVA design system.
- Local-only bridge using loopback HTTP and Native Messaging host `com.nova.downloadmanager`.

### Installer and desktop integration

- Branded NSIS installer header and sidebar generated from the NOVA visual identity.
- Install, upgrade, maintenance/repair-style reinstall, uninstall, legacy cleanup, and Native Messaging registration hooks.
- Native Messaging manifest generation for Chromium-family browsers and Firefox.
- Safe process handling: NOVA targets only processes launched from the installed application directory.

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
  ├─ Direct files      → in-process libcurl multi
  ├─ HLS/DASH/media   → yt-dlp + FFmpeg
  ├─ Browser bridge   → loopback HTTP + Native Messaging
  └─ Installer hooks  → NSIS lifecycle + registry/native-host setup
```

The central principle is that all user-facing controls are derived from engine capabilities. The root desktop app uses `EngineCapabilityContext`; the browser extension consumes daemon capabilities before sending candidates; the daemon performs final validation before starting a task.

## Repository structure

```text
.
├─ .github/                         Product CI and Dependabot configuration
├─ browser-extension/               Manifest V3 extension source, tests, and packaging tools
├─ docs/                            All documentation except this root README
│  ├─ architecture/                 Engine, capability, and source-tree architecture
│  ├─ extension/                    Browser extension documentation and CI templates
│  ├─ maintenance/                  Dependabot and product-maintenance notes
│  └─ release/                      Release, store, testing, and publishing documentation
├─ public/                          Desktop public assets
├─ scripts/                         Build, audit, native curl, cleanup, and release helpers
├─ src/                             Desktop React interface
├─ src-tauri/                       Rust daemon, libcurl engine, Native Messaging, NSIS config
├─ .editorconfig                    Repository-wide editor rules
├─ .gitattributes                   Repository-wide line-ending and binary policy
├─ .gitignore                       Repository-wide generated-file policy
├─ package.json                     Root product scripts and orchestration
└─ pnpm-workspace.yaml              Root package-manager policy
```

The browser extension is a product submodule in source layout only. It no longer carries its own nested GitHub workflow, Dependabot, docs, devcontainer, duplicate repository policy files, or extension-local lockfile. Those are centralized at the repository root or under `docs/`.

## Requirements

- Node.js 24, pinned by `.node-version`.
- pnpm 11.x, pinned by `packageManager`.
- Rust stable toolchain.
- CMake and native C/C++ build tools for production `libcurl` builds.
- FFmpeg for complete media post-processing.
- Windows is required for building the final NSIS installer.

## Development

Install dependencies:

```bash
pnpm install
```

Build the native curl runtime and helper engines:

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

Run extension development:

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

Build the Tauri/NSIS installer:

```bash
pnpm run native-curl:build
pnpm run fetch-engines
pnpm run extension:package
pnpm run tauri:build
```

The production pipeline builds a static `libcurl` from the latest stable upstream curl release, exports the Cargo link environment, stages helper engines, packages the browser extension, and builds the branded NSIS installer.

## Quality gates

Root product checks:

```bash
pnpm run lint
pnpm run lint:eslint
pnpm test
pnpm run verify:capabilities
pnpm run audit:installer
pnpm run audit:final
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

The current source audit intentionally warns if `src-tauri/Cargo.lock` has not yet been regenerated after adding `curl/curl-sys`. Run `cargo check` in a Rust-enabled environment and commit the updated lockfile before publishing a binary release.

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

- `src-tauri/windows/installer-header.bmp`
- `src-tauri/windows/installer-sidebar.bmp`
- `src-tauri/windows/hooks.nsi`

The single source for product icons, logos, and installer banners is `branding/source`. Regenerate all target-specific artwork with `pnpm run branding:generate`; the copied files under Tauri, Vite, and WXT folders are generated build inputs, not separate branding sources.

The installer lifecycle covers install, upgrade, repair-style maintenance reinstall, uninstall, legacy artifact cleanup, Native Messaging registration, and Start Menu repair/uninstall shortcuts. CI fallback builds use SemVer build metadata (`v0.1.0+<run>`) instead of prerelease suffixes so rerunning a newer CI installer is treated as an in-place maintenance/update install, while real lower-version downgrades stay blocked. User data is preserved unless the uninstaller is explicitly instructed to remove application data.

## Documentation

All documentation except this root README is centralized under [`docs/`](docs/README.md):

- [Project structure](docs/architecture/PROJECT_STRUCTURE.md)
- [Capability gating](docs/architecture/CAPABILITY_GATING.md)
- [Engine compatibility](docs/architecture/ENGINE_COMPATIBILITY.md)
- [Browser extension](docs/extension/README.md)
- [Dependabot and maintenance](docs/maintenance/DEPENDABOT_AND_MAINTENANCE.md)
- [Release process](docs/release/RELEASE.md)
- [Testing](docs/release/TESTING.md)
- [Store compliance](docs/release/STORE_COMPLIANCE.md)

## Support and community

NOVA is an independent project. Support helps fund maintenance, browser-store packaging, testing, and engine integration work.

<p align="center">
  <!-- Community & Support -->
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
