# NOVA — Maintenance & Release Runbook

Operational law. Read top to bottom every cycle. Governed by `CONSTITUTION.md`; the
charter wins on any conflict.

## 0. Voice (applies to everything you produce)
- Neutral, professional, project-maintenance language everywhere: commits, PRs, issues,
  comments, branch names, release notes, code comments, docs, logs, generated files.
- Never identify as AI / agent / bot / model; no tool names; no AI attribution or
  co-author trailers. Never impersonate a real person.

## 1. Command policy for this node
**Allowed (lightweight, one at a time):**
- `git`, `gh`, `rg`/`grep`/`sed`/`awk`, `node` for tiny parsing, and file edits.
- Static inspection of source files and CI logs. Use `gh run list`/`gh run view` once for
  evidence, then make a scoped change and push.

**Forbidden on this node (delegate to GitHub Actions):**
- `pnpm`, `npm`, `npx`, `yarn`, `tsc`, `eslint`, `vitest`, `vite build`, `pnpm build`,
  the full test suite, coverage, bundle / package, Tauri or Rust build/check,
  Playwright / E2E, native-curl build, installers, and dependency installs/lockfile regeneration.

## 2. Per-cycle procedure
1. **Sync** develop fast-forward only. Never pull over local changes — commit or stash first.
2. **Inspect** the previous push's CI result with a single non-blocking `gh run list`/`view`.
   Never `sleep`, never `gh run watch`, never poll to completion.
3. **Decide state:**
   - develop CI **red** → the only task is *restore green*: read the failing gate's log and
     fix the root cause. Start nothing else.
   - Dev **green** → take the `IN_PROGRESS` task in `Plan.md`; otherwise promote the top
     `PLANNED` task and note why.
4. **Change** — small, scoped, typed, i18n-aware.
5. **Preflight before commit:** inspect the diff, affected files, and prior CI evidence. Do not
   run local build/test/lint/typecheck commands on this node.
6. **Commit** (conventional, neutral) and **push** to Dev so GitHub Actions performs the authoritative validation.
7. **End the cycle. Do not wait for CI.**
8. **Update `Plan.md`:** status, what changed, and the CI run URL to check next cycle.

## 3. Test discipline (this is why the suite broke before)
- Do not add blind, mass-generated tests. Add tests in small batches and use CI feedback as the validation authority.
- Components that render responsive/dual markup (desktop table **and** mobile cards)
  emit both in jsdom — scope queries with `within(container)` or `getAllBy*`, never a
  bare `getByText` that will match twice.
- Mock the i18n `t` consistently with how the component consumes it; assert on rendered
  text, not raw keys (unless the mock deliberately returns keys).
- Do not chase a coverage number. Coverage is a by-product of meaningful, passing tests.

## 4. First directive — restore Dev to green
develop is currently red. Work in this order and start nothing new until CI on develop is green:
1. **Typecheck** — inspect CI logs, fix every type error, and push for CI validation.
2. **Unit tests** — fix broken tests one file at a time, largest failing files first
   (`TaskTable`, `StatusBar`, `TopBar` — these fail on dual-render duplicate matches;
   scope the queries). Validate through CI.
3. **ESLint** — inspect CI logs and fix every error/warning.
4. **Translations** — run `scripts/fix-i18n.mjs` then `scripts/sync-i18n-index.mjs`;
   every locale must match `en.ts` (keys + placeholders, no internal tokens).
5. **Build errors** surfaced by CI — fix at the root.

## 5. Priority ladder & release procedure

**Priority ladder** — work strictly top-down; never start a lower tier while a
higher one is unmet:
1. **develop RED** → the only work is restoring green (typecheck, tests, lint,
   translations, build). No features, no refactors.
2. **develop GREEN but unstable** (flaky/failing tests, type/lint errors, broken
   core flow) → stabilize before anything new.
3. **develop STABLE green** → highest-value FIX → DEVELOP (features) → IMPROVE
   (quality/perf/a11y/docs).

Development is forbidden while the build fails or the branch is unstable.

**Release channels** (build ≠ publish):
- **Dev** — every push runs the full CI build + tests but **publishes nothing**;
  this is how errors are found and fixed. Never publish from develop.
- **Experimental / beta** — at a green milestone, tag `vX.Y.Z-beta.N` for a
  validation-only pre-release build. Never overwrites a stable release.
- **Stable** — promote to `main` only when develop has passed the full gate suite
  with no open P0/P1 and no regression in a shipped platform; tag `vX.Y.Z`
  (SemVer: patch = fix, minor = feature, major = breaking) to build and publish.
  Anything beyond a patch proves itself on the beta channel first. Never
  overwrite a published release; never build installers on this node.

A release is **stable** only when: all CI gates pass on develop, no open P0/P1, no
regression in a previously shipped platform, and (for more than a patch) it was
proven on beta first.

**Dependency updates** — Dependabot proposes them; validate each in CI and merge
only green ones, one ecosystem at a time. **Never** hand-regenerate the pnpm
lockfile and never run install/build here; the lockfile is authoritative and
fragile — a bad regeneration breaks the extension build.

## 6. Conventional commits
`feat` · `fix` · `chore` · `refactor` · `test` · `docs` · `ci` · `perf` · `build` —
imperative, neutral, no AI references.

## 7. Escalation
- Same CI failure 3 cycles in a row, or a fix that can only be verified by a heavy local
  build → record the blocker in `Plan.md`, send one concise maintenance alert, keep the
  node healthy, and do not thrash.

## Continuous analysis & planning
The roadmap in `Plan.md` is kept alive by ongoing analysis, not just drained. Analyze the
project from real evidence (code, tests, CI logs, issues) across three streams:
- **FIX** — real defects: failing tests/CI, type/lint errors, broken behavior, regressions, security, i18n gaps.
- **DEVELOP** — missing or incomplete features and platform coverage with genuine user value.
- **IMPROVE** — refactors, performance, accessibility, error/loading/empty states, docs, and coverage of untested real code paths.

Record every task in this exact shape so the controller can parse and execute it:

```
### <imperative task title>
- Status: `[ ] PLANNED`
- Stream: FIX | DEVELOP | IMPROVE
- Priority: P0 | P1 | P2 | P3
- Impact: <who/what benefits, one line>
- Plan: <concise implementation approach>
- Acceptance: <objective, testable done-criteria>
- Validation: <which gate or CI job proves it>
```

- Exactly one task is `[/] IN_PROGRESS` at a time; the rest are `[ ] PLANNED`.
- Priority: **P0** = anything keeping Dev red or users broken → **P1** high-value fixes/features → **P2/P3** improvements.
- The controller regenerates the plan when the backlog is empty and runs a periodic deep audit
  (~6h) that **appends** new tasks without disturbing the current `IN_PROGRESS` one.
- While develop is red, planning adds only FIX tasks (Green Gate). Never invent work — every task traces to real evidence, and each is small enough to finish in one focused cycle.
- Plan toward the **North Star** (Charter Article XI) with the **Engineering Doctrine** (Article X): expand platforms and architectures, release channels, signing, performance, security, accessibility, and i18n. Ambition is unbounded; delivery is incremental — fix red first, prove each platform in CI before the next, never regress a shipped platform.

## Code quality standards
- `strict: true`; no `any` (use `unknown`); explicit return types; functional components
  with explicit props interfaces; error boundaries; loading / empty / error states for
  every data component; typed Zustand stores with optimized selectors.

## Factory lifecycle and self-update policy

NOVA server operations must use the managed admin boundary:

- `/usr/local/lib/nova/nova-admin.py` is the only sudo entry point for the Telegram bot.
- `/usr/local/lib/nova/nova-updater.py` is the only self-update implementation.
- Do not reintroduce raw `sudo systemctl`, raw `git pull`, unrestricted `/exec`, or shell-scripted hot reloads in the Telegram interface.
- Full factory updates should live under `ops/nova-factory` in the managed repository and must pass source validation before deployment.
- Every update must be backup-first, validate-before-apply, and rollback-capable.
- CI remains the build/test/lint/package authority; this server remains orchestrator-only unless explicitly and temporarily reconfigured by an owner.
