# Contributing to NOVA Download Manager

Thanks for your interest in improving NOVA. This document covers the development
setup, the quality gates every change must pass, and the conventions this
repository follows.

## Project layout

NOVA is a single product in one repository. See
[docs/architecture/PROJECT_STRUCTURE.md](docs/architecture/PROJECT_STRUCTURE.md)
for the full map. In short:

- `src/` — desktop React interface.
- `src-tauri/` — Rust daemon, linked `libcurl` engine, Native Messaging host,
  and NSIS installer configuration.
- `browser-extension/` — Manifest V3 browser companion (source layout only;
  policy and docs are centralized at the root and under `docs/`).
- `scripts/` — build, audit, native-curl, and release helpers.
- `docs/` — all documentation except the root `README.md`.

## Requirements

- **Node.js 24** (pinned by `.node-version`).
- **pnpm 11.x** (pinned by `packageManager` in `package.json`).
- **Rust stable** toolchain.
- CMake and native C/C++ build tools for production `libcurl` builds.
- FFmpeg for complete media post-processing.
- Windows is required to build the final NSIS installer.

## Getting started

```bash
pnpm install
cp .env.example .env        # optional: adjust local overrides
pnpm run tauri:dev          # run the desktop app
# or
pnpm run dev                # frontend only, against an existing daemon
```

For extension development:

```bash
pnpm --filter nova-browser-extension dev
```

## Quality gates

Run these before opening a pull request. CI (`.github/workflows/ci.yml`)
enforces the same gates.

**Root / desktop:**

```bash
pnpm run lint            # tsc --noEmit
pnpm run lint:eslint
pnpm test
pnpm run i18n:validate
pnpm run audit:final     # capability gating + installer lifecycle + extension sync/release audits
```

**Browser extension:**

```bash
pnpm --filter nova-browser-extension typecheck
pnpm --filter nova-browser-extension verify:offline
pnpm --filter nova-browser-extension build:zip
```

**Rust:**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml
```

## Conventions

- **Formatting** is handled by Prettier (`.prettierrc`) and EditorConfig
  (`.editorconfig`). Run `pnpm run format` before committing.
- **No fake capabilities.** User-facing controls must be derived from runtime
  engine capabilities. Do not surface a protocol, media option, or feature that
  the linked engine does not actually support — the capability-gating audit will
  reject it. See
  [docs/architecture/CAPABILITY_GATING.md](docs/architecture/CAPABILITY_GATING.md).
- **Single control plane.** Do not reintroduce nested CI, Dependabot, lockfiles,
  or duplicated repository-policy files inside `browser-extension/`; the
  `audit:final` gate enforces centralization at the root.
- **Internationalization.** UI strings go through the i18n system; run
  `pnpm run i18n:sync` and `pnpm run i18n:validate` after touching translation
  keys.
- **Commit messages** should be clear and imperative. Group a logical change
  into a coherent commit.

## Pull requests

1. Branch from `main`.
2. Make the change and ensure all quality gates above pass locally.
3. Update relevant docs under `docs/` and add a `CHANGELOG.md` entry under
   `[Unreleased]`.
4. Open the PR against `main` with a clear description of the change and its
   motivation.

## Security

Do not report security vulnerabilities through public issues or pull requests.
Follow the process in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT
License in [LICENSE](LICENSE).
