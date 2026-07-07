# Project Plan

## Rules

- Work is executed from top to bottom by priority.
- Only one task may be `IN_PROGRESS` at a time.
- Unfinished tasks must be resumed before new tasks start.
- Completed tasks older than 30 full days must be removed from this file.
- Every task must include start date, completion date, status, branch, PR link if available, validation results, and notes.
- Major changes require research and a written plan before implementation.
- Stable releases require full validation before publishing.
- The server is a repository orchestration node only; build, test, lint, coverage, packaging, audit, and release validation run through GitHub Actions.
- Repository output must use neutral project-maintenance language in commits, pull requests, issues, comments, release notes, documentation, logs, and generated project files.

## Status Legend

- `[ ] PLANNED`
- `[/] IN_PROGRESS`
- `[x] COMPLETED`
- `[!] BLOCKED`
- `[-] CANCELLED`

## Operating Policy

- Primary development branch: `Dev`.
- Stable branch: `main`.
- Normal work branches: `dev/<task-id>`.
- Release stabilization branches: `release/<version>`.
- Hotfix branches: `hotfix/<task-id>`.
- Pull requests target `Dev` unless preparing a verified stable release or hotfix.
- Never push directly to `main`.
- Never force-push, delete tags, delete releases, rewrite history, or bypass CI.
- If the current run must stop, record status, progress, next step, validation state, and any blocker in this file.

## Validation Policy

- Local server commands for build, test, lint, typecheck, coverage, packaging, audit, dependency install, and release are not used.
- Validation source of truth is GitHub Actions.
- When CI fails, inspect logs with `gh`, fix the root cause, push a focused update, and record the result here.
- Stable release gates require green CI, valid SemVer without prerelease suffix, release notes, generated artifacts, no unresolved blockers, and no unresolved high or critical security issue unless explicitly accepted.

---

## Active Task

### SUSTAIN-001 — CI-backed coverage expansion and controller policy alignment

- Status: `[/] IN_PROGRESS`
- Priority: critical
- Type: testing
- Source branch: `Dev`
- Work branch: `dev/sustain-001`
- Target branch: `Dev`
- Started: 2026-07-07
- Completed: pending
- PR: pending
- Validation:
  - install: pending
  - lint: pending
  - typecheck: pending
  - test: pending
  - build: pending
  - audit: pending
- Objective:
  - Continue the current coverage expansion while aligning repository planning, service text, and Telegram interface wording with neutral project-maintenance policy.
- Plan:
  1. Preserve the existing in-progress test and UI changes without reverting them.
  2. Replace legacy planning text with the required task structure and long-term sustainability roadmap.
  3. Keep the server in orchestration-only mode and prevent local build/test/lint/audit commands from service-controlled processes.
  4. Commit and push a focused update when the worktree is coherent.
  5. Monitor GitHub Actions, inspect failures with `gh`, and fix any CI failure in the next cycle.
- Progress:
  - Current worktree already contains expanded unit test coverage for scheduler, dialogs, capabilities, pages, language metadata, state, API, and component behavior.
  - Service text and Telegram interface wording are being aligned with neutral project-maintenance language.
  - Local command blocking is active for service-controlled `pnpm`, `npm`, `npx`, `vitest`, `eslint`, `tsc`, `vite`, `tauri`, `cargo`, and `playwright` invocations.
- Notes:
  - Validation remains pending until GitHub Actions runs after the next push.
  - Do not start another task until this one is completed, blocked, or cancelled.

---

## Planned Tasks

### CI-002 — Harden CI quality workflow for Dev

- Status: `[ ] PLANNED`
- Priority: critical
- Type: ci
- Source branch: `Dev`
- Work branch: `dev/ci-002`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - install: pending
  - lint: pending
  - typecheck: pending
  - test: pending
  - build: pending
  - audit: pending
- Objective:
  - Ensure `Dev` receives fast, reliable CI feedback for install, lint, typecheck, tests, build, audit, and i18n validation.
- Plan:
  1. Inspect existing workflows and package scripts.
  2. Ensure CI uses the repository lockfile and correct Node/pnpm versions.
  3. Split fast validation from heavy release builds where useful.
  4. Add clear artifact/log retention for failed runs.
- Progress:
  - pending
- Notes:
  - Server-side local validation remains disabled.

### TEST-002 — Expand critical user-flow coverage

- Status: `[ ] PLANNED`
- Priority: high
- Type: testing
- Source branch: `Dev`
- Work branch: `dev/test-002`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - install: pending
  - lint: pending
  - typecheck: pending
  - test: pending
  - build: pending
  - audit: pending
- Objective:
  - Increase confidence around downloads, scheduler, settings, task table behavior, capability gating, and error states.
- Plan:
  1. Review current tests and uncovered critical paths.
  2. Add focused unit and integration tests for high-risk UI and state behavior.
  3. Prepare E2E coverage plan for CI execution.
  4. Record CI results and residual gaps.
- Progress:
  - pending
- Notes:
  - Avoid weakening assertions to make checks pass.

### UI-002 — Interaction, accessibility, and translation audit

- Status: `[ ] PLANNED`
- Priority: high
- Type: ui
- Source branch: `Dev`
- Work branch: `dev/ui-002`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - install: pending
  - lint: pending
  - typecheck: pending
  - test: pending
  - build: pending
  - audit: pending
- Objective:
  - Audit buttons, menus, dialogs, toolbars, status elements, translations, keyboard access, and disabled states.
- Plan:
  1. Inventory all interactive elements.
  2. Add or correct labels, tooltips, aria labels, and translation keys.
  3. Verify disabled/error/offline states map to real capability state.
  4. Add regression tests where behavior is important.
- Progress:
  - pending
- Notes:
  - Keep UI changes scoped and consistent with the current design language.

### SEC-001 — Secret and release-safety audit

- Status: `[ ] PLANNED`
- Priority: high
- Type: security
- Source branch: `Dev`
- Work branch: `dev/sec-001`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - install: pending
  - lint: pending
  - typecheck: pending
  - test: pending
  - build: pending
  - audit: pending
- Objective:
  - Remove hardcoded secrets, validate ignored operational files, and ensure `main` remains production-clean.
- Plan:
  1. Scan tracked files for secrets and server-local operational files.
  2. Confirm runtime secrets come only from protected environment files or GitHub secrets.
  3. Add CI checks that prevent unsafe files from entering release branches.
  4. Document any required credential rotation.
- Progress:
  - pending
- Notes:
  - Any exposed credential must be rotated outside the repository.

### RELEASE-001 — Release-channel workflow readiness

- Status: `[ ] PLANNED`
- Priority: medium
- Type: release
- Source branch: `Dev`
- Work branch: `dev/release-001`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - install: pending
  - lint: pending
  - typecheck: pending
  - test: pending
  - build: pending
  - audit: pending
- Objective:
  - Prepare dev, nightly, alpha, beta, rc, stable, and hotfix release workflows with strict gates.
- Plan:
  1. Inspect existing release scripts and workflows.
  2. Define channel-specific source refs and version formats.
  3. Ensure stable releases are triggered only from `main` after all gates pass.
  4. Add release notes/changelog checks.
- Progress:
  - pending
- Notes:
  - Do not publish if any validation gate fails.

### PERF-001 — Performance and bundle-health review

- Status: `[ ] PLANNED`
- Priority: medium
- Type: performance
- Source branch: `Dev`
- Work branch: `dev/perf-001`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - install: pending
  - lint: pending
  - typecheck: pending
  - test: pending
  - build: pending
  - audit: pending
- Objective:
  - Identify slow render paths, unnecessary state updates, oversized bundles, and expensive workflows.
- Plan:
  1. Review state selectors and high-frequency UI updates.
  2. Inspect CI build output and bundle artifacts.
  3. Prioritize fixes with measurable impact.
- Progress:
  - pending
- Notes:
  - Measurements should come from CI artifacts or repeatable local developer commands outside the server runner.

---

## Completed Tasks

### INFRA-001 — Orchestration-only server runtime

- Status: `[x] COMPLETED`
- Priority: critical
- Type: ci
- Source branch: `Dev`
- Work branch: `dev/infra-001`
- Target branch: `Dev`
- Started: 2026-07-07
- Completed: 2026-07-07
- PR: pending
- Validation:
  - install: not-applicable
  - lint: not-applicable
  - typecheck: not-applicable
  - test: not-applicable
  - build: not-applicable
  - audit: not-applicable
- Objective:
  - Keep the 1GB server limited to repository orchestration and CI monitoring.
- Plan:
  1. Disable local build/test/lint/audit command execution for service-controlled processes.
  2. Keep service supervision active across restart and failure.
  3. Route validation to GitHub Actions.
- Progress:
  - Service command blocking is active.
  - Controller, monitor, watchdog timer, maintenance timer, and Telegram interface are enabled.
- Notes:
  - No local heavy validation is expected on this server.

---

## Blocked Tasks

No blocked tasks currently recorded.
