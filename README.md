# NOVA Download Manager

NOVA is a native desktop download manager built with **Qt 6.8 / QML / C++20** and a headless **Rust** download runtime. The browser companion is a Manifest V3 extension that communicates with NOVA through a local-only API and Native Messaging.

The former React/Vite/Tauri desktop interface has been removed. **Qt/QML is the only desktop UI in the repository and the primary mainline desktop implementation.**

## Architecture

```text
Qt/QML desktop application (desktop-native/)
        │
        │ authenticated loopback API + event stream
        ▼
Rust runtime (src-tauri/)
  ├─ nova-native-backend
  ├─ libcurl multi direct engine
  ├─ yt-dlp + FFmpeg media workflows
  ├─ queues / scheduler / rules / diagnostics
  └─ nova-native-host
        │
        ▼
Manifest V3 browser extension (browser-extension/)
```

The UI is a presentation and desktop-integration layer. Download execution, capability validation, persistence, queue policy and media processing remain daemon-owned.

## Native desktop UI

The approved NOVA shell includes:

- frameless native window with a compact title bar and global Downloads search;
- collapsible navigation rail with hidden, icons-only and expanded modes;
- single-row icon command bar with secondary actions under an overflow menu;
- configurable download table, sorting, filtering and persistent columns;
- optional right-side task inspector with live transfer metrics and speed history;
- queues, scheduler, batch import, media downloader and link grabber;
- native tray, notifications, file/folder dialogs and platform progress integration;
- diagnostics, runtime logs, engine controls, browser-integration repair and update checks;
- persistent layout customization for density, accent, corner radius and panel visibility;
- English and Arabic release UI with complete key parity and application-wide RTL support.

The current release language scope is intentionally **English + Arabic**. Additional languages are deferred until the native desktop interface and release validation are complete.

## Runtime and browser capabilities

NOVA uses linked `libcurl multi` for direct transfers and routes adaptive media workflows to yt-dlp/FFmpeg when supported. The daemon advertises runtime capabilities, and both the Qt frontend and browser extension gate unsupported protocols/options before submission.

Browser integration uses:

- loopback-only daemon discovery;
- scoped bearer credentials;
- Native Messaging host `com.nova.downloadmanager`;
- secret-proof automatic pairing;
- Chrome/Edge extension identity derived from the pinned manifest key;
- Firefox extension identity pinned in the extension manifest.

## Repository structure

```text
.
├─ desktop-native/       Qt 6/QML/C++ desktop application, tests and UI gates
├─ src-tauri/            Rust daemon/runtime and Native Messaging binaries
├─ browser-extension/    Manifest V3 companion extension
├─ android/              Android foundation
├─ crates/               Shared Rust cores/mobile bridge
├─ branding/source/      Canonical product artwork
├─ scripts/              Runtime, branding, security and release helpers
├─ docs/                 Architecture, verification and release documentation
└─ .github/              CI, release automation and dependency policy
```

There is no React/Vite/Tauri desktop source tree. Node/pnpm at the repository root is used only for repository tooling and the browser-extension workspace.

## Requirements

For desktop development:

- Qt **6.8+** with Quick, Quick Controls 2, Network and Widgets;
- CMake **3.24+**;
- a C++20 compiler;
- Rust stable;
- native libcurl/OpenSSL development libraries appropriate to the platform.

For browser-extension work, Node.js 24 and pnpm 11 are used.

## Build the native desktop application

Build the Rust runtime:

```bash
cargo build --manifest-path src-tauri/Cargo.toml --release \
  --bin nova-native-backend --bin nova-native-host
```

Configure and build Qt:

```bash
cmake -S desktop-native -B build/native \
  -DCMAKE_BUILD_TYPE=Release -DNOVA_BUILD_TESTS=ON
cmake --build build/native --config Release --parallel
ctest --test-dir build/native -C Release --output-on-failure
```

The same operations are available through root scripts:

```bash
pnpm run runtime:check
pnpm run runtime:test
pnpm run native:configure
pnpm run native:build
pnpm run native:test
pnpm run native:check
```

## Browser extension

```bash
pnpm install --frozen-lockfile
pnpm --filter nova-browser-extension typecheck
pnpm --filter nova-browser-extension test:unit
pnpm --filter nova-browser-extension verify:offline
pnpm run extension:package
```

See [docs/extension/README.md](docs/extension/README.md) for the extension capture model and packaging details.

## Quality gates

The native desktop pipeline builds six OS/architecture targets:

- Windows x64 and ARM64
- Linux x64 and ARM64
- macOS Intel and Apple Silicon

Static/native gates cover:

- English/Arabic localization completeness;
- hard-coded user-visible copy;
- approved UI shell contract;
- keyboard and accessibility semantics;
- WCAG text/focus contrast, including all selectable accents;
- High-DPI 125% and 200% Qt display tests;
- large-list/recovery behavior;
- packaged Native Messaging framing and authenticated capture handoff;
- browser/Qt/Rust Native Messaging identity consistency.

Run repository security and branding checks with:

```bash
pnpm run security:check
pnpm run branding:verify
pnpm run facts:verify
```

## Production-readiness policy

Qt/QML is already the primary desktop UI. The production release gate is intentionally stricter than mainline adoption. `node desktop-native/scripts/check-parity.mjs --require-complete` blocks release tagging until every production gate is covered and `releaseReplacementReady` is true.

The remaining external validation areas are tracked in `desktop-native/parity/parity-manifest.json`, including real-browser packaged E2E, signed updater installation, complete six-platform candidate validation, and final assistive-technology/mixed-DPI testing.

## Security

The daemon binds to loopback, uses scoped authentication, validates outbound destinations against SSRF-sensitive ranges and applies final capability/protocol validation before starting work. See [SECURITY.md](SECURITY.md) for reporting instructions.

## Android

Android remains a separate product surface under `android/` with shared Rust code under `crates/`. Its foundation workflow is independent from the Qt desktop build.

## License and project links

NOVA is distributed under the [MIT License](LICENSE). Bundled/managed third-party engine notices are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Project/maintainer links:

- GitHub: https://github.com/Alaa91H
- Support: https://ko-fi.com/alaa91h
- Telegram: https://t.me/Alaa91h
- Email: mailto:alahus2591@gmail.com
