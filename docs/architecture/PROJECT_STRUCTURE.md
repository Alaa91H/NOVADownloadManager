# NOVA Download Manager Project Structure

NOVA is organized as one product with one repository control plane. The desktop UI, Rust daemon, browser extension, installer, audits, and documentation must stay aligned through root-owned scripts and root-owned CI.

## Runtime surfaces

- `src-tauri/` — Rust/Tauri daemon, in-process `libcurl multi` engine, media routing, Native Messaging host, NSIS hooks, and local loopback API.
- `src/` — desktop React UI. Every engine-dependent control must read from `EngineCapabilityContext`.
- `browser-extension/` — Manifest V3 browser companion source, tests, contracts, packaging tools, and WXT configuration.
- `scripts/` — root build, native-curl, installer, audit, cleanup, i18n, and release helpers.
- `.github/` — the single executable CI, release, and Dependabot control plane for the whole product. This is the single CI and Dependabot control plane for desktop, daemon, installer, and extension work.
- `docs/` — all product documentation except the root `README.md`.

## Centralization policy

The browser extension is part of the product, not an independent repository. It must not contain nested repository-management files such as `.github/`, `.devcontainer/`, extension-local `.gitignore`, extension-local `.npmrc`, extension-local `.nvmrc`, or extension-local documentation folders.

Executable automation belongs in root `.github/`. Historical or reference-only extension CI/build templates belong under `docs/extension/ci-templates/`.

## Generated-file policy

Generated directories and local outputs must not be committed:

- `node_modules/`
- `dist/`
- `build/`
- `.output/`
- `.wxt/`
- `src-tauri/target/`
- `src-tauri/resources/`
- `bin/`
- `vendor/native/`
- release archives and installers
- logs, temporary files, caches, diagnostics, and test reports

The root `.gitignore` is the canonical ignore policy for both the desktop app and the browser extension.

## Package-management policy

The root package owns orchestration. The extension keeps its own `package.json` because WXT and store packaging need extension-local commands, but package-manager policy is centralized at the root through `.npmrc`, `.node-version`, `.prettierrc`, `.editorconfig`, `.gitattributes`, `.gitignore`, `.github/dependabot.yml`, and `.github/workflows/build.yml`.

## Documentation policy

The only documentation allowed outside `docs/` is the root `README.md`. Extension documentation belongs in `docs/extension/`, release/store material belongs in `docs/release/` (forthcoming), and maintenance policy belongs in `docs/maintenance/`.
