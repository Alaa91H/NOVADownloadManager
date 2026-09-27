# New Features Acceptance Evidence

This file records evidence for the 2026-09-27 completion plan. A row is only marked
**passed** when the command/scenario actually ran against the listed SHA and environment.

| Task | SHA | Environment | Command / scenario | Result | Evidence | Remaining |
|---|---|---|---|---|---|---|
| T00 | `5df4e443` | GitHub Actions, PR #208 | Rust daemon compatibility | passed | CI run 36148148464 | Desktop jobs stopped at accessibility before Qt build |
| T00 | `fffaafb3` | GitHub Actions, PR #209 | Initial baseline gates | superseded | run 36341315756 | Later commits superseded this SHA |
| T00 | current PR #209 head | GitHub Actions | six native desktop targets | running | NOVA Unified CI | Do not mark covered until build + CTest + package smoke complete |
| T01 | current PR #209 head | source contract | `node scripts/check-runtime-contract.mjs` | running | CI gate added | Runtime clients must remain compatible with contract v1 |
| T02 | current PR #209 head | source + CI | real `/api/queues` implementation | implementation present | `src-tauri/src/daemon/routes/queues.rs` | Real-daemon restart/CRUD contract test still required |
| T19 | current PR #209 head | GitHub Actions | `node scripts/run-shared-core-tests.mjs` | running | CI gate added | Device/browser/release suites remain independent gates |

## Evidence rules

- Static/source checks prove only the contract they inspect.
- Fake HTTP servers prove client request/response behavior, not daemon integration.
- A skipped job is **not** a pass.
- Device, browser-install, installer, signing and update evidence must name the actual environment.
- Release evidence must refer to one version/commit SHA; results from a pre-stamping commit cannot prove a later candidate.
