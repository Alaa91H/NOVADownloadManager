# Unification and Stability Audit

This note records the repository cleanup required to keep NOVA Download Manager as one maintainable product instead of two loosely connected projects.

## Scope

- Desktop React/Tauri source tree.
- Browser extension package, WXT build tooling, tests, and release gates.
- Root CI and Dependabot policy.
- Documentation placement under `docs/`.
- Repository-wide ignore, lockfile, and workspace policy.

## Decisions

- The repository uses one pnpm workspace and one root `pnpm-lock.yaml`.
- `browser-extension/package.json` remains package-local because WXT and store packaging need package-local scripts.
- `browser-extension/pnpm-lock.yaml` is intentionally not committed. The extension is resolved through the root workspace lockfile.
- Executable GitHub workflows and Dependabot configuration live only under root `.github/`.
- CI/build templates that are not directly executed remain under `docs/extension/ci-templates/` as documentation fixtures.
- Generated artifacts, package outputs, local runtime files, duplicate lockfiles, and extension build output are ignored at the repository root.

## Validated gates

The following dependency-light checks are expected to pass without downloading Node dependencies:

```bash
node scripts/final-audit.mjs
node scripts/verify-capability-gating.mjs
node scripts/installer-lifecycle-audit.mjs
cd browser-extension && python -m pytest tests -q
cd browser-extension && node tools/offline-production-audit.mjs
```

The following gates require a full local/CI environment with Node 24, pnpm 11.6.0, Rust, and native build tooling:

```bash
pnpm install --frozen-lockfile
pnpm run lint
pnpm run lint:eslint
pnpm test
pnpm --filter nova-browser-extension typecheck
pnpm --filter nova-browser-extension verify:offline
pnpm run extension:package
cargo check --manifest-path src-tauri/Cargo.toml
```

## Known release requirement

`src-tauri/Cargo.lock` must be regenerated in a Rust-enabled environment after validating the final curl/curl-sys dependency graph. The root source audit currently reports this as a release warning rather than silently hiding it.
