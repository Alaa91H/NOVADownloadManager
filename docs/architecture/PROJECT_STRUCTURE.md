# NOVA Download Manager Project Structure

NOVA uses one repository control plane for the native desktop application, Rust runtime, browser companion, Android foundation, shared cores, documentation and release automation.

## Runtime surfaces

- `desktop-native/` — the only desktop UI: Qt 6.8+, QML/Qt Quick Controls 2 and C++20.
- `src-tauri/` — headless Rust runtime. The directory name is retained for history, but the crate no longer depends on Tauri or a WebView. It builds `nova-native-backend` and `nova-native-host`.
- `browser-extension/` — Manifest V3 browser companion, tests and WXT packaging.
- `android/` — Android application foundation.
- `crates/` — shared Rust model/download/mobile libraries.
- `scripts/` — native runtime, branding, security and release helpers.
- `.github/` — executable CI/release/Dependabot control plane.
- `docs/` — product documentation except the root README.

## Desktop ownership boundary

Qt owns presentation, local UI preferences and OS integration. Rust owns transfer execution, engine capabilities, task state, queue/scheduler policy, media processing and browser handoff state. QML/C++ must not duplicate the daemon as a second download-state authority.

## Retired desktop stack

The former `src/` React tree, Vite entry points, Tauri window/bootstrap/configuration, WebView asset server, NSIS/Tauri installer sources and associated desktop-web tooling were removed when Qt became the primary UI.

Repository fact checks reject reintroduction of those retired paths.

## Package management

Root Node dependencies are repository scripting only. The browser extension retains its own package manifest inside the root pnpm workspace. Rust dependency management stays in Cargo and Qt dependency management stays in CMake.

## Generated outputs

Do not commit build/runtime outputs such as `node_modules/`, `build/`, extension `.output/`, Rust `target/`, downloaded engines, release archives, logs or test reports.
