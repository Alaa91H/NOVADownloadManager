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
- `tsc --noEmit` — first-line typecheck; **required clean before every push.** Give the
  one-shot typecheck an adequate heap so the model's smaller cap does not starve it:
  `NODE_OPTIONS=--max-old-space-size=896 npx tsc --noEmit`.
- `eslint` on the specific files you changed.
- `vitest run <single-file>` (memory-capped) — verify a test you just touched, one file at a time.

**Forbidden on this node (delegate to GitHub Actions):**
- `pnpm install` / lockfile regeneration, `vite build` / `pnpm build`, the full
  `pnpm test` suite, coverage, bundle / package, Tauri or Rust build/check,
  Playwright / E2E, native-curl build, installers.

## 2. Per-cycle procedure
1. **Sync** Dev fast-forward only. Never pull over local changes — commit or stash first.
2. **Inspect** the previous push's CI result with a single non-blocking `gh run list`/`view`.
   Never `sleep`, never `gh run watch`, never poll to completion.
3. **Decide state:**
   - Dev CI **red** → the only task is *restore green*: read the failing gate's log and
     fix the root cause. Start nothing else.
   - Dev **green** → take the `IN_PROGRESS` task in `Plan.md`; otherwise promote the top
     `PLANNED` task and note why.
4. **Change** — small, scoped, typed, i18n-aware.
5. **Preflight (mandatory before commit):**
   - `tsc --noEmit` is clean.
   - If you touched a test, run that test file; it must pass.
   - ESLint is clean on changed files.
6. **Commit** (conventional, neutral) and **push** to Dev.
7. **End the cycle. Do not wait for CI.**
8. **Update `Plan.md`:** status, what changed, and the CI run URL to check next cycle.

## 3. Test discipline (this is why the suite broke before)
- **Never commit a test you have not executed green.** No blind, mass-generated tests.
- Add tests in small batches; verify each file locally before committing it.
- Components that render responsive/dual markup (desktop table **and** mobile cards)
  emit both in jsdom — scope queries with `within(container)` or `getAllBy*`, never a
  bare `getByText` that will match twice.
- Mock the i18n `t` consistently with how the component consumes it; assert on rendered
  text, not raw keys (unless the mock deliberately returns keys).
- Do not chase a coverage number. Coverage is a by-product of meaningful, passing tests.

## 4. First directive — restore Dev to green
Dev is currently red. Work in this order and start nothing new until CI on Dev is green:
1. **Typecheck** — `tsc --noEmit`, fix every type error.
2. **Unit tests** — fix broken tests one file at a time, largest failing files first
   (`TaskTable`, `StatusBar`, `TopBar` — these fail on dual-render duplicate matches;
   scope the queries). Verify each file locally before committing.
3. **ESLint** — fix every error/warning.
4. **Translations** — run `scripts/fix-i18n.mjs` then `scripts/sync-i18n-index.mjs`;
   every locale must match `en.ts` (keys + placeholders, no internal tokens).
5. **Build errors** surfaced by CI — fix at the root.

## 5. Release procedure (only from green)
- Ensure Dev is green, then merged to `main`.
- Bump version (SemVer): patch = fix, minor = feature, major = breaking.
- Tag `vX.Y.Z`; GitHub Actions builds and publishes. Never build installers here.
  Never overwrite a published release.

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
- While Dev is red, planning adds only FIX tasks (Green Gate). Never invent work — every task traces to real evidence, and each is small enough to finish in one focused cycle.
- Plan toward the **North Star** (Charter Article XI) with the **Engineering Doctrine** (Article X): expand platforms and architectures, release channels, signing, performance, security, accessibility, and i18n. Ambition is unbounded; delivery is incremental — fix red first, prove each platform in CI before the next, never regress a shipped platform.

## Code quality standards
- `strict: true`; no `any` (use `unknown`); explicit return types; functional components
  with explicit props interfaces; error boundaries; loading / empty / error states for
  every data component; typed Zustand stores with optimized selectors.
