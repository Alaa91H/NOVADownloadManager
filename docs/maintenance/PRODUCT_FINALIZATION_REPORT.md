# NOVA Final Product Polish Report

## Scope completed

- Desktop daemon, React UI, browser extension, NSIS installer, build scripts, CI, and release hygiene were audited as one product.
- Browser extension parity is checked against the public `Alaa91H/NOVA-Extension` feature surface: aggressive capture, page-context network/media interception, deep DOM scan, smart overlay, HLS/DASH, local-only privacy, and zero-click pairing contract.
- Extension popup/options/diagnostics use the same dark glass design tokens, radius system, accent color, logo usage, and capability wording as the desktop UI.
- NSIS installer uses NOVA-branded header/sidebar images, safe process shutdown, maintenance-mode reinstall/repair behavior, uninstall cleanup, and registry lifecycle hardening.
- Tauri resources can now include a prebuilt unpacked browser extension when extension build output exists before `tauri:build`.
- Final audits check source cleanliness, installer lifecycle, extension parity, release policy, runtime capability gating, and stale-artifact absence.

## Installer lifecycle behavior

- Fresh install: stops no unrelated processes, installs files, writes receipt/registry metadata.
- Maintenance/repair install: detected when `$INSTDIR\\nova.exe` already exists; stops only NOVA-owned processes, removes obsolete install artifacts, overwrites application files/resources, preserves app data.
- Upgrade: uses the same maintenance-safe path; app data and downloads are preserved.
- Uninstall: stops only NOVA-owned processes, unregisters browser native-host registry entries, removes install directory leftovers and Start Menu folder. Application data removal remains under the explicit Tauri uninstall app-data checkbox.

## Remaining environment-dependent validation

The source package is polished and audited, but final binary release proof still requires a real Windows CI/local environment with Node 24, pnpm 11, Rust/Cargo, CMake/vcpkg, and NSIS/Tauri toolchain to run:

```bash
pnpm install --frozen-lockfile
pnpm run audit:final
pnpm run fetch-engines
node scripts/print-native-curl-env.mjs
cargo check --manifest-path src-tauri/Cargo.toml
pnpm run extension:package
pnpm run tauri:build
```

`src-tauri/Cargo.lock` still needs to be regenerated with Cargo after the Rust libcurl dependency changes.

## 2026-07-06 Final NSIS + Native Messaging hardening pass

This pass closes the remaining product integration gap between the Windows installer, desktop daemon, and browser extension:

- Added an in-process Rust Native Messaging host mode to `nova.exe`. Browser native-host launches are detected from browser-provided arguments and handled without opening the desktop UI.
- Added a stdio Native Messaging proxy for `engine.status`, `task.list`, `task.pause`, `task.resume`, and `task.cancel`, forwarding to the verified loopback daemon.
- Added build-time native-host manifest generation in `scripts/build-tauri-assets.mjs` with Firefox ID support and optional Chromium store/development IDs via `NOVA_CHROMIUM_EXTENSION_IDS`.
- Hardened NSIS hooks to patch the native-host manifest path after install, register Chrome/Edge/Firefox host keys, cache a maintenance installer, create repair/uninstall shortcuts, and publish Apps & Features repair metadata.
- Extended CI validation so the browser extension is installed, typechecked, release-audited, and packaged during the validation path, not only during the installer build path.
- Extended final audits to verify Native Messaging, installer repair metadata, branded NSIS assets, extension feature parity, and absence of generated artifacts.

Repair model: NSIS/Tauri provide the standard install/uninstall wizard. NOVA adds repair by rerunning the cached signed installer over the existing installation while preserving app data and cleaning stale binaries/manifests. This is the correct NSIS maintenance model for this project; it is not an MSI-style automatic repair engine.

## Final unification pass

- Desktop UI engine gating is centralized in `EngineCapabilityContext`; Add Download, Batch Import, YouTube/Media download, and Task Properties consume the same capability snapshot.
- The browser extension no longer owns a nested Dependabot configuration in the integrated repository; root CI and root Dependabot cover product releases while the extension CI template remains for standalone extension audits.
- Root Dependabot now monitors npm `/`, npm `/browser-extension`, Cargo `/src-tauri`, and GitHub Actions `/`.
- Product documentation now has a root `docs/` map for project structure, capability gating, and dependency maintenance.

