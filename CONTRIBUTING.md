# Contributing to NOVA Download Manager

Thanks for contributing to NOVA. The desktop application is native Qt/QML; the Rust runtime and browser extension are separate runtime surfaces in the same repository.

## Project layout

- `desktop-native/` — Qt 6/QML/C++ desktop application and native UI tests.
- `src-tauri/` — headless Rust daemon/runtime and Native Messaging host. Despite the historical directory name, this crate no longer uses Tauri.
- `browser-extension/` — Manifest V3 companion extension.
- `android/` and `crates/` — Android foundation and shared Rust cores.
- `scripts/` — build, security, branding and release helpers.
- `docs/` — architecture, verification and release documentation.

Do not reintroduce the retired React/Vite/Tauri desktop shell.

## Requirements

- Qt 6.8+
- CMake 3.24+
- C++20 compiler
- Rust stable
- Node.js 24 + pnpm 11 for repository tooling/browser extension

## Native desktop setup

```bash
cargo build --manifest-path src-tauri/Cargo.toml --release \
  --bin nova-native-backend --bin nova-native-host

pnpm run native:configure
pnpm run native:build
pnpm run native:test
pnpm run native:check
```

For browser-extension development:

```bash
pnpm install --frozen-lockfile
pnpm --filter nova-browser-extension dev
```

## Quality gates

Before opening a pull request, run the gates relevant to your change.

Desktop:

```bash
pnpm run native:check
pnpm run native:configure
pnpm run native:build
pnpm run native:test
```

Rust runtime:

```bash
pnpm run runtime:check
pnpm run runtime:test
```

Browser extension:

```bash
pnpm --filter nova-browser-extension typecheck
pnpm --filter nova-browser-extension test:unit
pnpm --filter nova-browser-extension verify:offline
pnpm --filter nova-browser-extension build:zip
```

Repository checks:

```bash
pnpm run security:check
pnpm run branding:verify
pnpm run facts:verify
```

## Conventions

- UI copy belongs in the native English/Arabic localization dictionaries.
- New native controls must remain keyboard accessible and expose useful accessibility metadata.
- Engine-dependent controls must be gated by daemon capabilities.
- Download/task state remains daemon-owned; do not create a second execution source of truth in QML.
- Keep browser-extension repository policy centralized at the root.
- Use clear, imperative commit messages and keep a commit focused on one logical change.

## Pull requests

1. Branch from `main`.
2. Run the relevant native/runtime/extension checks.
3. Update tests and documentation with behavior changes.
4. Add an `[Unreleased]` CHANGELOG entry for user-visible changes.
5. Open the pull request against `main`.

Production release tagging additionally requires:

```bash
node desktop-native/scripts/check-parity.mjs --require-complete
```

This release gate is stricter than ordinary mainline development.

## Security

Do not disclose vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).

## License

Contributions are licensed under the repository's [MIT License](LICENSE).
