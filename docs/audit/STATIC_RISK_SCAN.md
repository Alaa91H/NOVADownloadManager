# Static Audit Report

**Refresh date:** 18 August 2026
**Scope:** the Git-tracked `NOVADownloadManager` repository, including the Rust core, the TypeScript interface, the browser extension, and build tooling.

> This report replaces an old raw snapshot that was copying millions of characters from search outputs, including generated text and content not suitable for reference. The raw snapshot caused repository bloat and hid important results, so here we record executable gates and their results instead of copying matching code content.

| Audit gate | Reproducible command | Result in this run |
|---|---|---|
| Final source audit | `pnpm run audit:final` | Passed: **0 warnings** |
| Project capabilities and repository unification audit | part of `pnpm run audit:final` | Passed |
| Installer lifecycle audit | part of `pnpm run audit:final` | Passed |
| Brand assets audit | part of `pnpm run audit:final` | Passed: 70 managed files |
| Browser extension consistency and store release audit | part of `pnpm run audit:final` | Passed |
| RustSec | `cd src-tauri && cargo audit --deny warnings` | Passed under the documented exceptions in `src-tauri/audit.toml` |
| Clippy | `cargo clippy --locked --manifest-path src-tauri/Cargo.toml -- -D warnings` | Passed with no warnings |
| Text encoding integrity | `git grep -n $'\uFFFD' -- ':!pnpm-lock.yaml'` | Should have no matches in tracked files |

## Audit scope

The final audit examines risk patterns, application capability policies, and release delivery integration. A single string match in the code is not automatically a finding; results are reviewed in context, especially wrapped `unsafe` usages in Rust and `expect` usages inside tests. Any actionable finding is recorded in the specialized audit log with the rationale, the fix, and a regression test, for example `docs/audit/CURL_CORE_AUDIT.md`.

## Re-run policy

The table gates are re-run after every substantive fix and before each release. If any command reports a warning or failure, the commit must not be pushed to `main` until the root cause is fixed and a regression test is added where appropriate.
