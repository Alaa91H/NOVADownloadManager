# Project Plan

## Rules
- Work is executed from top to bottom by priority.
- Only one task may be "IN_PROGRESS" at a time.
- Unfinished tasks must be resumed before new tasks start.
- Completed tasks older than 30 full days must be removed from this file.
- Every task must include start date, completion date, status, branch, PR link if available, validation results, and notes.
- Major changes require research and a written plan before implementation.
- Stable releases require full validation before publishing.

## Status Legend
- "[ ] PLANNED"
- "[/] IN_PROGRESS"
- "[x] COMPLETED"
- "[!] BLOCKED"
- "[-] CANCELLED"

---

## Active Task

### QUALITY-001 — Full project audit & fix all errors/warnings

- Status: `[/] IN_PROGRESS`
- Priority: critical
- Type: testing
- Source branch: `Dev`
- Work branch: `ai/quality-audit`
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
  - Run full audit, fix every error and warning, ensure all quality gates pass cleanly.
- Plan:
  1. Run all validation scripts and document every issue
  2. Fix TypeScript errors
  3. Fix ESLint errors/warnings
  4. Fix formatting issues
  5. Fix test failures
  6. Fix build warnings
  7. Clean audit
  8. Update AGENTS.md reference
- Notes:
  - Foundation for all other work

---

## Planned Tasks

### TEST-001 — Add E2E tests with Playwright (reach 10%+ coverage)

- Status: `[ ] PLANNED`
- Priority: critical
- Type: testing
- Source branch: `Dev`
- Work branch: `ai/e2e-tests`
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
  - Install Playwright, write comprehensive E2E tests covering all major features, reach 10%+ code coverage.
- Plan:
  1. Install @playwright/test
  2. Configure Playwright (browsers, CI, reporters)
  3. Write E2E tests: downloads, settings, scheduler, sidebar, i18n, tasks, queue, API, UI components, navigation
  4. Add GitHub Actions workflow for E2E
  5. Validate coverage meets 10% threshold
- Notes:
  - Current coverage: ~3%, target: 10%

### BUILD-001 — Professional build configuration & quality gates

- Status: `[ ] PLANNED`
- Priority: high
- Type: ci
- Source branch: `Dev`
- Work branch: `ai/build-config`
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
  - Optimize Vite/Tauri build configs, add cross-platform CI matrix, enforce strict quality gates.
- Plan:
  1. Review and optimize vite.config.ts
  2. Review and optimize vitest.config.ts
  3. Review and optimize tsconfig.json
  4. Create CI workflow with full matrix (Windows/Linux/macOS, x64/ARM64)
  5. Enforce quality gates in CI
  6. Create release workflow

### PLATFORM-001 — Cross-platform deployment matrix

- Status: `[ ] PLANNED`
- Priority: high
- Type: release
- Source branch: `Dev`
- Work branch: `ai/cross-platform`
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
  - Enable builds for Windows (x64, x86, ARM64), Linux (x64, ARM64), macOS (x64, ARM64). Research Android/iOS.
- Plan:
  1. Add Tauri cross-compilation targets
  2. Update CI for multi-arch matrix
  3. Test Linux ARM64 build
  4. Test macOS x64 + ARM64 build
  5. Test Windows x86 + ARM64 build
  6. Research Android/iOS feasibility (Capacitor)
  7. Document platform status

### INFRA-002 — GitHub Actions opencode workflow

- Status: `[ ] PLANNED`
- Priority: medium
- Type: ci
- Source branch: `Dev`
- Work branch: `ai/github-actions-workflow`
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
  - Configure GitHub Actions to run opencode on schedule and on issue/PR comments.
- Plan:
  1. Create .github/workflows/opencode.yml
  2. Configure schedule and event triggers
  3. Add appropriate secrets
- Notes:
  - Model: opencode/big-pickle

### REL-001 — Release channels & automated releases

- Status: `[ ] PLANNED`
- Priority: medium
- Type: release
- Source branch: `Dev`
- Work branch: `ai/release-automation`
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
  - Automate all release channels: dev, nightly, alpha, beta, rc, stable, hotfix.
- Plan:
  1. Review release scripts
  2. Create release workflow
  3. Test with dev channel
  4. Document release process

### DEV-002 — Code quality hardening

- Status: `[ ] PLANNED`
- Priority: medium
- Type: refactor
- Source branch: `Dev`
- Work branch: `ai/code-quality`
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
  - Refactor for high code quality: strict types, error handling, performance, architecture.
- Plan:
  1. Review all components for proper error/loading/empty states
  2. Add error boundaries
  3. Optimize Zustand selectors
  4. Remove dead code
  5. Improve type safety (no any)
  6. Add proper JSDoc for public APIs

---

## Completed Tasks

### BOT-001 — Telegram bot for agent control & notifications

- Status: `[x] COMPLETED`
- Priority: high
- Type: infra
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Full Telegram bot with /start, /status, /log, /exec, /quality, /plan management, /git, /opencode, /build
  - Agent sends automatic notifications at each cycle phase
  - Systemd service nova-bot.service running in parallel with nova-dev-agent.service
  - Commands: /register, /plan_add, /plan_start, /plan_done, /plan_block for task management

### INFRA-001 — Set up continuous development infrastructure

- Status: `[x] COMPLETED`
- Priority: critical
- Type: ci
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Plan.md created, Dev branch created, opencode 1.17.14 installed on server
  - systemd service running 24/7, Zen Big Pickle configured, 8GB swap created

---

## Blocked Tasks

*None yet.*
